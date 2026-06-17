import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  withBreaker,
  getCircuitState
} from './openai-circuit-breaker.js';

// Helper: reset circuit to closed state between tests
function resetCircuit(): void {
  recordSuccess();
}

// Helper: trigger exactly N failures
function failN(n: number): void {
  for (let i = 0; i < n; i++) {
    recordFailure();
  }
}

test('Estado inicial: circuito fechado', () => {
  resetCircuit();
  assert.equal(isCircuitOpen(), false);
  const { state, failureCount } = getCircuitState();
  assert.equal(state, 'closed');
  assert.equal(failureCount, 0);
});

test('4 falhas: circuito permanece fechado (abaixo do threshold)', () => {
  resetCircuit();
  failN(4);
  assert.equal(isCircuitOpen(), false);
  assert.equal(getCircuitState().state, 'closed');
});

test('5 falhas: circuito abre (atinge FAILURE_THRESHOLD)', () => {
  resetCircuit();
  failN(5);
  assert.equal(isCircuitOpen(), true);
  assert.equal(getCircuitState().state, 'open');
});

test('6 falhas: circuito permanece aberto', () => {
  resetCircuit();
  failN(6);
  assert.equal(isCircuitOpen(), true);
  assert.equal(getCircuitState().state, 'open');
});

test('recordSuccess reseta estado para closed e zera contador', () => {
  resetCircuit();
  failN(5);
  assert.equal(isCircuitOpen(), true);
  recordSuccess();
  assert.equal(isCircuitOpen(), false);
  const { state, failureCount } = getCircuitState();
  assert.equal(state, 'closed');
  assert.equal(failureCount, 0);
});

test('recordSuccess em estado fechado não quebra nada', () => {
  resetCircuit();
  recordSuccess();
  assert.equal(isCircuitOpen(), false);
  assert.equal(getCircuitState().state, 'closed');
});

test('Transição open → half-open após OPEN_DURATION_MS (mock de Date.now)', () => {
  resetCircuit();

  const originalNow = Date.now;
  let fakeTime = Date.now();

  // Forçar abertura do circuito
  Date.now = () => fakeTime;
  failN(5);
  assert.equal(isCircuitOpen(), true);

  // Avançar 30 segundos
  fakeTime += 30_001;
  Date.now = () => fakeTime;

  // Após timeout, isCircuitOpen deve retornar false (half-open: deixa passar uma requisição)
  assert.equal(isCircuitOpen(), false);
  assert.equal(getCircuitState().state, 'half-open');

  Date.now = originalNow;
  resetCircuit();
});

test('Falha em half-open reabre circuito', () => {
  resetCircuit();

  const originalNow = Date.now;
  let fakeTime = Date.now();

  Date.now = () => fakeTime;
  failN(5);
  assert.equal(isCircuitOpen(), true);

  // Avançar para half-open
  fakeTime += 30_001;
  Date.now = () => fakeTime;
  assert.equal(isCircuitOpen(), false); // transição para half-open
  assert.equal(getCircuitState().state, 'half-open');

  // Nova falha em half-open deve reabrir
  recordFailure();
  assert.equal(getCircuitState().state, 'open');
  assert.equal(isCircuitOpen(), true);

  Date.now = originalNow;
  resetCircuit();
});

test('Sucesso em half-open fecha o circuito', () => {
  resetCircuit();

  const originalNow = Date.now;
  let fakeTime = Date.now();

  Date.now = () => fakeTime;
  failN(5);

  fakeTime += 30_001;
  Date.now = () => fakeTime;
  assert.equal(isCircuitOpen(), false); // half-open

  recordSuccess();
  assert.equal(getCircuitState().state, 'closed');
  assert.equal(isCircuitOpen(), false);

  Date.now = originalNow;
  resetCircuit();
});

test('withBreaker: executa fn quando circuito fechado', async () => {
  resetCircuit();
  const result = await withBreaker(
    async () => 'ok',
    () => 'fallback'
  );
  assert.equal(result, 'ok');
});

test('withBreaker: retorna fallback quando circuito aberto', async () => {
  resetCircuit();
  failN(5);
  assert.equal(isCircuitOpen(), true);

  const result = await withBreaker(
    async () => 'ok',
    () => 'fallback'
  );
  assert.equal(result, 'fallback');
  resetCircuit();
});

test('withBreaker: registra sucesso após fn bem-sucedida', async () => {
  resetCircuit();
  failN(4); // 4 falhas, ainda fechado
  await withBreaker(
    async () => 'ok',
    () => 'fallback'
  );
  // recordSuccess deve ter resetado o contador
  assert.equal(getCircuitState().failureCount, 0);
  assert.equal(getCircuitState().state, 'closed');
});

test('withBreaker: registra falha e relança erro quando fn lança', async () => {
  resetCircuit();

  await assert.rejects(
    () => withBreaker(
      async () => { throw new Error('boom'); },
      () => 'fallback'
    ),
    /boom/
  );

  assert.equal(getCircuitState().failureCount, 1);
  resetCircuit();
});

test('withBreaker: após 5 erros consecutivos, abre circuito e retorna fallback', async () => {
  resetCircuit();

  // Disparar 4 rejeições via withBreaker para acumular falhas
  for (let i = 0; i < 4; i++) {
    await assert.rejects(
      () => withBreaker(async () => { throw new Error('err'); }, () => 'fb'),
      /err/
    );
  }
  assert.equal(getCircuitState().failureCount, 4);
  assert.equal(isCircuitOpen(), false);

  // 5ª falha abre o circuito
  await assert.rejects(
    () => withBreaker(async () => { throw new Error('err'); }, () => 'fb'),
    /err/
  );
  assert.equal(isCircuitOpen(), true);

  // Próxima chamada deve cair no fallback
  const result = await withBreaker(async () => 'ok', () => 'fallback-circuit');
  assert.equal(result, 'fallback-circuit');

  resetCircuit();
});

test('Janela de falhas: falhas fora da janela de 60s resetam contador', () => {
  resetCircuit();

  const originalNow = Date.now;
  let fakeTime = Date.now();

  Date.now = () => fakeTime;
  failN(4); // 4 falhas dentro da janela
  assert.equal(getCircuitState().failureCount, 4);

  // Avançar 61 segundos (fora da janela de 60s)
  fakeTime += 61_000;
  Date.now = () => fakeTime;

  // Nova falha: deve resetar contador para 1 (não acumular com os anteriores)
  recordFailure();
  assert.equal(getCircuitState().failureCount, 1);
  assert.equal(getCircuitState().state, 'closed');

  Date.now = originalNow;
  resetCircuit();
});

test('isCircuitOpen retorna true enquanto ainda dentro de OPEN_DURATION_MS', () => {
  resetCircuit();

  const originalNow = Date.now;
  let fakeTime = Date.now();

  Date.now = () => fakeTime;
  failN(5);
  assert.equal(isCircuitOpen(), true);

  // Avançar 29 segundos (ainda dentro dos 30s de abertura)
  fakeTime += 29_000;
  Date.now = () => fakeTime;

  assert.equal(isCircuitOpen(), true);
  assert.equal(getCircuitState().state, 'open');

  Date.now = originalNow;
  resetCircuit();
});

test('getCircuitState retorna failureCount correto durante estado open', () => {
  resetCircuit();
  failN(5);
  const { state, failureCount } = getCircuitState();
  assert.equal(state, 'open');
  assert.equal(failureCount, 5);
  resetCircuit();
});

test('withBreaker: executa fn em half-open e fecha circuito em sucesso', async () => {
  resetCircuit();

  const originalNow = Date.now;
  let fakeTime = Date.now();

  Date.now = () => fakeTime;
  failN(5);

  // Avançar para half-open
  fakeTime += 30_001;
  Date.now = () => fakeTime;
  assert.equal(isCircuitOpen(), false); // half-open: deixa passar

  // withBreaker deve executar fn e fechar o circuito no sucesso
  const result = await withBreaker(async () => 'recovered', () => 'fallback');
  assert.equal(result, 'recovered');
  assert.equal(getCircuitState().state, 'closed');

  Date.now = originalNow;
  resetCircuit();
});

test('withBreaker: falha em half-open via withBreaker reabre circuito', async () => {
  resetCircuit();

  const originalNow = Date.now;
  let fakeTime = Date.now();

  Date.now = () => fakeTime;
  failN(5);

  fakeTime += 30_001;
  Date.now = () => fakeTime;
  assert.equal(isCircuitOpen(), false); // half-open

  await assert.rejects(
    () => withBreaker(async () => { throw new Error('still broken'); }, () => 'fb'),
    /still broken/
  );
  assert.equal(getCircuitState().state, 'open');

  Date.now = originalNow;
  resetCircuit();
});
