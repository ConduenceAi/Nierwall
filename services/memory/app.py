"""Nierwall memory service: Zep's open-source engine (Graphiti) on embedded FalkorDB.

Listens on 127.0.0.1:7421 only. The brain is its only client and sends two kinds of input:
the user's own messages and Nierwall's structured events. Outside text (token names, memos,
websites) is never written here, so it can't poison the memory.

No outside AI service sees the memory. Facts are pulled out by the brain's NEAR AI model (a verified
TEE, encrypted end to end), reached through the brain's local API, and the embeddings that search
runs on are made on this Mac.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import threading
from collections.abc import Iterable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

os.environ.setdefault("GRAPHITI_TELEMETRY_ENABLED", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# The embedding model is public: fetch it anonymously, never with a Hugging Face login saved on this Mac.
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            if value.strip():
                os.environ.setdefault(key.strip(), value.strip())
# Memory used OpenAI until 2026-11-18. A key still in .env must not let any library fall back to it.
os.environ.pop("OPENAI_API_KEY", None)

import httpx  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastembed import TextEmbedding  # noqa: E402
from openai import AsyncOpenAI  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.cross_encoder.client import CrossEncoderClient  # noqa: E402
from graphiti_core.driver.falkordb_driver import FalkorDriver  # noqa: E402
from graphiti_core.edges import EntityEdge  # noqa: E402
from graphiti_core.embedder.client import EmbedderClient  # noqa: E402
from graphiti_core.errors import EdgeNotFoundError, GroupsEdgesNotFoundError  # noqa: E402
from graphiti_core.llm_client.config import LLMConfig  # noqa: E402
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient  # noqa: E402
from graphiti_core.nodes import EpisodeType  # noqa: E402
from graphiti_core.search.search_filters import ComparisonOperator, DateFilter, SearchFilters  # noqa: E402
from redislite.async_falkordb_client import AsyncFalkorDB  # noqa: E402

log = logging.getLogger("memory")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [memory] %(message)s")

DATA = Path(os.environ.get("GUARDIAN_DATA_DIR", ROOT / "data"))
if not DATA.is_absolute():
    DATA = ROOT / DATA
DATA.mkdir(parents=True, exist_ok=True)
GROUP = "guardian-user"

BRAIN_URL = f"http://127.0.0.1:{os.environ.get('GUARDIAN_PORT', '7420')}"
BRAIN_INFO = Path.home() / "Library" / "Application Support" / "Guardian" / "brain.json"
# Small and quick on a laptop: 384 numbers per text, about 70 MB, fetched once from Hugging Face the first time
# the service starts. Nothing of yours goes with that download.
EMBED_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDER_ID = f"fastembed:{EMBED_MODEL}"


def brain_token() -> str:
    """The brain's local API token: GUARDIAN_TOKEN, or the one the brain wrote for this run (new on each restart)."""
    if os.environ.get("GUARDIAN_TOKEN"):
        return os.environ["GUARDIAN_TOKEN"]
    try:
        return json.loads(BRAIN_INFO.read_text())["token"]
    except (OSError, ValueError, KeyError):
        return ""


PLAIN = (str, int, float, bool, type(None))


def conform(result: dict, model: type[BaseModel], *, plain_only: bool) -> dict:
    """Keeps only the fields Graphiti asked for. Shown a JSON schema, the model now and then answers in its shape
    ({"description": ..., "properties": {...}}) or adds keys of its own; seen live with GLM on 2026-11-18. An entity's
    attributes must also be plain values, the only kind FalkorDB stores."""
    fields = model.model_fields
    if not any(k in fields for k in result) and isinstance(result.get("properties"), dict):
        result = result["properties"]
    out = {k: v for k, v in result.items() if k in fields}
    if plain_only:
        out = {k: v for k, v in out.items() if isinstance(v, PLAIN) or (isinstance(v, list) and all(isinstance(x, PLAIN) for x in v))}
    return out


class BrainLLM(OpenAIGenericClient):
    async def generate_response(self, messages, response_model=None, *args, **kwargs):
        result = await super().generate_response(messages, response_model, *args, **kwargs)
        if response_model is None or not isinstance(result, dict):
            return result
        return conform(result, response_model, plain_only=bool(kwargs.get("attribute_extraction")))


def brain_llm() -> OpenAIGenericClient:
    """Graphiti's model calls, sent to the brain, which passes them to its verified NEAR AI model, encrypted."""

    async def add_token(request: httpx.Request) -> None:
        request.headers["x-guardian-token"] = brain_token()

    client = AsyncOpenAI(
        api_key="unused",  # the brain holds the NEAR AI key
        base_url=f"{BRAIN_URL}/api/memory/llm",
        http_client=httpx.AsyncClient(timeout=180, event_hooks={"request": [add_token]}),
        max_retries=1,
    )
    return BrainLLM(
        config=LLMConfig(model="near-ai", small_model="near-ai", temperature=0),
        client=client,
        max_tokens=4096,
        # The schema goes into the prompt, which is encrypted, instead of a request field, which isn't.
        structured_output_mode="json_object",
    )


class LocalEmbedder(EmbedderClient):
    """Embeddings made on this Mac (fastembed, ONNX). Searching memory sends nothing anywhere."""

    def __init__(self) -> None:
        self.model = TextEmbedding(EMBED_MODEL, cache_dir=str(DATA / "models"))
        self.lock = threading.Lock()

    def _embed(self, texts: list[str]) -> list[list[float]]:
        with self.lock:
            return [v.tolist() for v in self.model.embed(texts)]

    async def create(self, input_data: str | list[str] | Iterable[int] | Iterable[Iterable[int]]) -> list[float]:
        # Graphiti passes one text, as a string or a list of one.
        text = input_data if isinstance(input_data, str) else next(iter(input_data))
        return (await self.create_batch([str(text)]))[0]

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return await asyncio.to_thread(self._embed, input_data_list)


class LocalReranker(CrossEncoderClient):
    """Orders passages by how close they are to the query, with the local embeddings. Nierwall's search doesn't
    rerank; this is here so Graphiti never makes its default reranker, which calls OpenAI."""

    def __init__(self, embedder: LocalEmbedder) -> None:
        self.embedder = embedder

    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        if not passages:
            return []
        q, *rest = await self.embedder.create_batch([query, *passages])
        scores = [cosine(q, v) for v in rest]
        return sorted(zip(passages, scores, strict=True), key=lambda p: p[1], reverse=True)


def cosine(a: list[float], b: list[float]) -> float:
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b, strict=True)) / norm if norm else 0.0


async def reembed_if_needed(driver: FalkorDriver, embedder: LocalEmbedder) -> None:
    """Embeddings from different models can't be compared, so a graph built with another one (OpenAI's, before
    2026-11-18) is re-embedded here, once, on this Mac. The facts themselves stay as they are."""
    marker = DATA / "memory.embedder"
    if marker.exists() and marker.read_text().strip() == EMBEDDER_ID:
        return
    counts = {}
    for name, find, match, field, text in (
        ("entities", "MATCH (n:Entity)", "MATCH (n:Entity {uuid: row.uuid})", "n.name_embedding", "n.name"),
        ("communities", "MATCH (n:Community)", "MATCH (n:Community {uuid: row.uuid})", "n.name_embedding", "n.name"),
        ("facts", "MATCH ()-[n:RELATES_TO]->()", "MATCH ()-[n:RELATES_TO {uuid: row.uuid}]->()", "n.fact_embedding", "n.fact"),
    ):
        records, _, _ = await driver.execute_query(f"{find} WHERE {text} IS NOT NULL RETURN n.uuid AS uuid, {text} AS text")
        for i in range(0, len(records), 64):
            chunk = records[i : i + 64]
            vectors = await embedder.create_batch([r["text"] for r in chunk])
            rows = [{"uuid": r["uuid"], "v": v} for r, v in zip(chunk, vectors, strict=True)]
            await driver.execute_query(f"UNWIND $rows AS row {match} SET {field} = vecf32(row.v)", rows=rows)
        counts[name] = len(records)
    marker.write_text(EMBEDDER_ID + "\n")
    if any(counts.values()):
        log.info("memory re-embedded on this Mac with %s: %s", EMBED_MODEL, counts)


# ---- DeFi ontology: what Nierwall's memory knows how to name ----
class Wallet(BaseModel):
    """A crypto wallet the user owns, referred to by its nickname (never an address)."""

    role: str | None = Field(None, description="What the user uses it for, e.g. everyday cash, long-term holdings, emergencies only")


class LendingPosition(BaseModel):
    """A loan or collateral position on a lending protocol."""

    protocol: str | None = Field(None, description="Lending protocol, e.g. Rhea or Aave")
    chain: str | None = Field(None, description="Blockchain, e.g. NEAR or Base")


class Goal(BaseModel):
    """Something the user is working toward, e.g. a house deposit or keeping a cash reserve."""

    target_date: str | None = Field(None, description="When, if the user said so")


class Preference(BaseModel):
    """How the user likes things done, e.g. prefers repaying over adding collateral, quiet hours."""

    strength: str | None = Field(None, description="always, usually, or prefers")


ENTITY_TYPES = {"Wallet": Wallet, "LendingPosition": LendingPosition, "Goal": Goal, "Preference": Preference}

state: dict = {"graphiti": None, "queue": None, "worker": None, "processed": 0, "failed": 0}


async def worker():
    """Ingests episodes one at a time (Graphiti's guidance for a single group)."""
    q: asyncio.Queue = state["queue"]
    while True:
        ep = await q.get()
        try:
            await state["graphiti"].add_episode(
                name=ep["name"],
                episode_body=ep["body"],
                source_description=ep["source_description"],
                reference_time=ep["reference_time"],
                source=EpisodeType[ep["type"]],
                group_id=GROUP,
                entity_types=ENTITY_TYPES,
            )
            state["processed"] += 1
        except Exception as e:  # keep the worker alive
            state["failed"] += 1
            log.warning("episode failed: %s", str(e)[:300])
        finally:
            q.task_done()


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = AsyncFalkorDB(str(DATA / "memory.falkordb"))
    # Graphiti keeps each group in its own graph, named after the group: read and write that one.
    driver = FalkorDriver(falkor_db=db, database=GROUP)
    embedder = LocalEmbedder()
    g = Graphiti(
        graph_driver=driver,
        llm_client=brain_llm(),
        embedder=embedder,
        cross_encoder=LocalReranker(embedder),
        store_raw_episode_content=False,
        max_coroutines=4,  # a few model calls at a time is plenty for one person's memory
    )
    await g.build_indices_and_constraints()
    await reembed_if_needed(driver, embedder)
    state["graphiti"] = g
    state["queue"] = asyncio.Queue()
    state["worker"] = asyncio.create_task(worker())
    log.info("memory ready (facts from NEAR AI via %s, embeddings on this Mac, db=%s)", BRAIN_URL, DATA / "memory.falkordb")
    yield
    state["worker"].cancel()
    await g.close()


app = FastAPI(title="Nierwall memory", lifespan=lifespan)


class EpisodeIn(BaseModel):
    name: str = Field(max_length=200)
    type: Literal["message", "json", "text"] = "message"
    body: str = Field(max_length=10_000)
    source_description: str = Field(default="Nierwall", max_length=200)
    reference_time: datetime | None = None


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    limit: int = Field(default=8, ge=1, le=50)


def fact_out(e: EntityEdge) -> dict:
    iso = lambda d: d.isoformat() if d else None  # noqa: E731
    return {"uuid": e.uuid, "fact": e.fact, "validAt": iso(e.valid_at), "invalidAt": iso(e.invalid_at), "createdAt": iso(e.created_at)}


@app.get("/health")
async def health():
    q = state["queue"]
    return {
        "ok": state["graphiti"] is not None,
        "facts": "NEAR AI, through the brain",
        "embeddings": EMBEDDER_ID,
        "queued": q.qsize() if q else 0,
        "processed": state["processed"],
        "failed": state["failed"],
    }


@app.post("/episodes")
async def add_episode(ep: EpisodeIn):
    await state["queue"].put({
        "name": ep.name, "type": ep.type, "body": ep.body, "source_description": ep.source_description,
        "reference_time": ep.reference_time or datetime.now(timezone.utc),
    })
    return {"queued": True, "position": state["queue"].qsize()}


@app.post("/search")
async def search(body: SearchIn):
    current_only = SearchFilters(invalid_at=[[DateFilter(comparison_operator=ComparisonOperator.is_null)]])
    edges = await state["graphiti"].search(body.query, group_ids=[GROUP], num_results=body.limit, search_filter=current_only)
    return [fact_out(e) for e in edges if e.invalid_at is None]


@app.get("/facts")
async def facts(limit: int = 50):
    try:
        edges = await EntityEdge.get_by_group_ids(state["graphiti"].driver, [GROUP], limit=limit)
    except GroupsEdgesNotFoundError:
        return []
    return [fact_out(e) for e in edges if e.invalid_at is None]


@app.delete("/facts/{uuid}")
async def delete_fact(uuid: str):
    try:
        edge = await EntityEdge.get_by_uuid(state["graphiti"].driver, uuid)
    except EdgeNotFoundError:
        raise HTTPException(404, "fact not found")
    await edge.delete(state["graphiti"].driver)
    return {"ok": True}
