import test from 'node:test';
import assert from 'node:assert/strict';
import { __whatsappOutboundTestables } from './whatsapp-outbound.js';

test('estratégia: fora da janela com Meta template usa meta_template_first', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: true,
    hasMetaTemplate: true,
    outsideConversationWindow: true,
    templateOutside24hEnabled: true
  });
  assert.equal(strategy, 'meta_template_first');
});

test('estratégia: fora da janela sem Meta template usa twilio_template_first', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: true,
    hasMetaTemplate: false,
    outsideConversationWindow: true,
    templateOutside24hEnabled: true
  });
  assert.equal(strategy, 'twilio_template_first');
});

test('estratégia: dentro da janela mantém freeform_first', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: true,
    hasMetaTemplate: true,
    outsideConversationWindow: false,
    templateOutside24hEnabled: true
  });
  assert.equal(strategy, 'freeform_first');
});

test('estratégia: sem templates sempre usa freeform_first', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: false,
    hasMetaTemplate: false,
    outsideConversationWindow: true,
    templateOutside24hEnabled: true
  });
  assert.equal(strategy, 'freeform_first');
});

test('estratégia: flag desabilitada força freeform mesmo fora da janela', () => {
  const strategy = __whatsappOutboundTestables.resolveOutboundStrategy({
    hasTemplateSid: true,
    hasMetaTemplate: true,
    outsideConversationWindow: true,
    templateOutside24hEnabled: false
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
