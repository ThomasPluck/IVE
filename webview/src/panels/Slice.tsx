// Slice panel — empty instruction text in v1 because workstream C
// (Joern) is stubbed. When CPG lands we render the dataflow list here.

export function Slice({ capabilities }: { capabilities: Record<string, { available: boolean; reason: string }> }) {
  const cpg = capabilities.cpg;
  const degraded = !cpg?.available;
  return (
    <div className="slice-empty">
      <p>Right-click a variable in the editor → Slice → Backward or Forward.</p>
      {degraded ? (
        <p className="degraded">Slicing unavailable — CPG not built. {cpg?.reason ?? ""}</p>
      ) : null}
    </div>
  );
}
