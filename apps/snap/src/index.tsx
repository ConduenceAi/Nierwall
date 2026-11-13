import type { OnTransactionHandler } from "@metamask/snaps-sdk";
import { SeverityLevel } from "@metamask/snaps-sdk";
import { Bold, Box, Divider, Heading, Row, Text } from "@metamask/snaps-sdk/jsx";

/** Nierwall's local brain. It listens only on 127.0.0.1, so analysis never leaves the user's Mac. */
const BRAIN = "http://127.0.0.1:7420";

type Finding = { severity: "info" | "warning" | "critical"; title: string; detail: string };
type Analysis = {
  status: "pass" | "warn" | "critical" | "unknown";
  summary: string;
  findings: Finding[];
  healthBefore?: number | null;
  healthAfter?: number | null;
  changes?: Array<{ label: string; value: string }>;
};

const HEADLINE: Record<Analysis["status"], string> = {
  pass: "Nierwall: looks fine",
  warn: "Nierwall: check this first",
  critical: "Nierwall: stop and check",
  unknown: "Nierwall: not checked",
};

const color = (s: Finding["severity"]) => (s === "critical" ? "error" : s === "warning" ? "warning" : "default");
const fmt = (h: number | null | undefined) => (h == null ? "no debt" : h.toFixed(2));

async function analyze(body: unknown): Promise<Analysis> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${BRAIN}/snap/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Analysis;
  } finally {
    clearTimeout(timer);
  }
}

export const onTransaction: OnTransactionHandler = async ({ transaction, chainId, transactionOrigin }) => {
  let result: Analysis;
  try {
    result = await analyze({ chainId, transaction, origin: transactionOrigin });
  } catch {
    result = {
      status: "unknown",
      summary: "Nierwall isn't reachable",
      findings: [{ severity: "info", title: "Nierwall isn't running on this Mac", detail: "This transaction was not checked. That is not the same as safe." }],
    };
  }

  const content = (
    <Box>
      <Heading>{HEADLINE[result.status]}</Heading>
      <Text>{result.summary}</Text>
      {result.healthBefore !== undefined || result.healthAfter !== undefined ? (
        <Row label="Health factor">
          <Text>
            {fmt(result.healthBefore)} → <Bold>{fmt(result.healthAfter)}</Bold>
          </Text>
        </Row>
      ) : null}
      {(result.changes ?? []).map((c) => (
        <Row label={c.label}>
          <Text>{c.value}</Text>
        </Row>
      ))}
      <Divider />
      {result.findings.map((f) => (
        <Box>
          <Text color={color(f.severity)}>
            <Bold>{f.title}</Bold>
          </Text>
          <Text color="alternative">{f.detail}</Text>
        </Box>
      ))}
      <Divider />
      <Text color="muted">Checked on your Mac against your positions and limits. Nierwall never signs or blocks; you decide.</Text>
    </Box>
  );

  return result.status === "critical" ? { content, severity: SeverityLevel.Critical } : { content };
};
