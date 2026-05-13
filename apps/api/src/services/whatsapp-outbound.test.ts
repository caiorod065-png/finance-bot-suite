import test from 'node:test';
import assert from 'node:assert/strict';
import { __whatsappOutboundTestables } from './whatsapp-outbound.js';

test('estratégia: fora da janela 24h com template ativo deve priorizar template', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: true,
    outsideConversationWindow: true,
    templateOutside24hEnabled: true
  });
  assert.equal(strategy, 'template_first');
});

test('estratégia: dentro da janela 24h mantém mensagem livre', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: true,
    outsideConversationWindow: false,
    templateOutside24hEnabled: true
  });
  assert.equal(strategy, 'freeform_first');
});

test('estratégia: sem template sempre usa mensagem livre', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: false,
    outsideConversationWindow: true,
    templateOutside24hEnabled: true
  });
  assert.equal(strategy, 'freeform_first');
});

test('fallback: erro 63015 deve acionar template', () => {
  assert.equal(
    __whatsappOutboundTestables.outsideWindowLikely('Twilio delivery failed: failed error_code=63015'),
    true
  );
});

test('fallback: erro sem pista de janela não aciona template automaticamente', () => {
  assert.equal(
    __whatsappOutboundTestables.outsideWindowLikely('Twilio API 401: unauthorized'),
    false
  );
});
