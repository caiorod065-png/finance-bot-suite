export default function Home() {
  return (
    <main style={{ maxWidth: 860, margin: "48px auto", padding: "0 16px" }}>
      <h1>Iara Autopilot</h1>
      <p>
        Serviço de auto-melhoria contínua da Iara. Use os endpoints em <code>/api/*</code>.
      </p>
      <ul>
        <li><code>POST /api/webhooks/whatsapp</code> — ingestão de mensagens</li>
        <li><code>GET /api/webhooks/whatsapp</code> — validação Meta webhook</li>
        <li><code>POST /api/internal/self-improve</code> — executar loop manualmente</li>
        <li><code>GET /api/internal/metrics</code> — métricas rápidas</li>
      </ul>
    </main>
  );
}
