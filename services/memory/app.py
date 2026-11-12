"""Nierwall memory service: Zep's open-source engine (Graphiti) on embedded FalkorDB.

Listens on 127.0.0.1:7421 only. The brain is its only client and sends two kinds of input:
the user's own messages and Nierwall's structured events. Outside text (token names, memos,
websites) is never written here, so it can't poison the memory.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

os.environ.setdefault("GRAPHITI_TELEMETRY_ENABLED", "false")

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            if value.strip():
                os.environ.setdefault(key.strip(), value.strip())

from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.driver.falkordb_driver import FalkorDriver  # noqa: E402
from graphiti_core.edges import EntityEdge  # noqa: E402
from graphiti_core.errors import EdgeNotFoundError, GroupsEdgesNotFoundError  # noqa: E402
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
HAS_LLM = bool(os.environ.get("OPENAI_API_KEY"))


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
    driver = FalkorDriver(falkor_db=db, database="guardian")
    kwargs = {}
    if not HAS_LLM:
        # Graphiti needs clients at init; give it placeholders so reads still work without a key.
        os.environ.setdefault("OPENAI_API_KEY", "missing")
    g = Graphiti(graph_driver=driver, store_raw_episode_content=False, **kwargs)
    await g.build_indices_and_constraints()
    state["graphiti"] = g
    state["queue"] = asyncio.Queue()
    state["worker"] = asyncio.create_task(worker())
    log.info("memory ready (llm=%s, db=%s)", HAS_LLM, DATA / "memory.falkordb")
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
    return {"ok": state["graphiti"] is not None, "llm": HAS_LLM, "queued": q.qsize() if q else 0, "processed": state["processed"], "failed": state["failed"]}


@app.post("/episodes")
async def add_episode(ep: EpisodeIn):
    if not HAS_LLM:
        raise HTTPException(503, "OPENAI_API_KEY is not set; memory can't extract facts yet")
    await state["queue"].put({
        "name": ep.name, "type": ep.type, "body": ep.body, "source_description": ep.source_description,
        "reference_time": ep.reference_time or datetime.now(timezone.utc),
    })
    return {"queued": True, "position": state["queue"].qsize()}


@app.post("/search")
async def search(body: SearchIn):
    if not HAS_LLM:
        raise HTTPException(503, "OPENAI_API_KEY is not set; search needs embeddings")
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
