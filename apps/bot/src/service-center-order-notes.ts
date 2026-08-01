import type { ModalSpec } from './service-center-components.js';

export function buildRequirementNoteModal(input: {
  orderId: string;
  requirementId: string;
  expectedVersion: number;
  expectedRequirementVersion: number;
}): ModalSpec {
  return {
    title: '🐾 这个席位希望怎样陪你',
    customId: `bc:rnm:${input.orderId}:${input.requirementId}:v${input.expectedVersion}:r${input.expectedRequirementVersion}`,
    components: [
      {
        type: 'TEXT_INPUT',
        customId: 'requirement-note',
        label: '例如：技术要求不高，会聊天就行',
        style: 'PARAGRAPH',
        required: false,
        maxLength: 500
      }
    ]
  };
}

export function buildOrderNotesModal(input: {
  orderId: string;
  expectedVersion: number;
  returnGame?: string;
}): ModalSpec {
  return {
    title: input.returnGame ? '📝 填写需求备注' : '📝 补充订单备注',
    customId: input.returnGame
      ? `bc:omn:${input.orderId}:${input.returnGame}:v${input.expectedVersion}`
      : `bc:modal:order-notes:${input.orderId}:v${input.expectedVersion}`,
    components: [
      {
        type: 'TEXT_INPUT',
        customId: 'notes',
        label: '补充备注（可选）',
        style: 'PARAGRAPH',
        required: false,
        maxLength: 500
      }
    ]
  };
}
