import type { ServiceCenterRoute } from './service-center-routes.js';

export function parseCatalogNotesRoute(customId: string): ServiceCenterRoute | null {
  const packageSelect = /^bc:package:([0-9a-f-]{36}):select:v([1-9][0-9]*)$/u.exec(customId);
  if (packageSelect)
    return {
      area: 'service-package-select',
      orderId: packageSelect[1]!,
      expectedVersion: Number(packageSelect[2])
    };
  const gameSelect = /^bc:game:([0-9a-f-]{36}):select:v([1-9][0-9]*)$/u.exec(customId);
  if (gameSelect)
    return {
      area: 'order-game-select',
      orderId: gameSelect[1]!,
      expectedVersion: Number(gameSelect[2])
    };
  const gameAction = /^bc:game:([0-9a-f-]{36}):([A-Z0-9_]{1,24}):open:v([1-9][0-9]*)$/u.exec(customId);
  if (gameAction)
    return {
      area: 'order-game-action',
      orderId: gameAction[1]!,
      game: gameAction[2]!,
      action: 'open',
      expectedVersion: Number(gameAction[3])
    };
  const packagePreview = /^bc:package:([0-9a-f-]{36}):([0-9a-f-]{36}):preview:v([1-9][0-9]*)$/u.exec(customId);
  if (packagePreview)
    return {
      area: 'service-package-action',
      orderId: packagePreview[1]!,
      servicePackageVersionId: packagePreview[2]!,
      action: 'preview',
      expectedVersion: Number(packagePreview[3])
    };
  const packageApply = /^bc:package:([0-9a-f-]{36}):([0-9a-f-]{36}):apply:v([1-9][0-9]*)$/u.exec(customId);
  if (packageApply)
    return {
      area: 'service-package-action',
      orderId: packageApply[1]!,
      servicePackageVersionId: packageApply[2]!,
      action: 'apply',
      expectedVersion: Number(packageApply[3])
    };
  const packageAction = /^bc:package:([0-9a-f-]{36}):(open|back):v([1-9][0-9]*)$/u.exec(customId);
  if (packageAction)
    return {
      area: 'service-package-action',
      orderId: packageAction[1]!,
      action: packageAction[2] as 'open' | 'back',
      expectedVersion: Number(packageAction[3])
    };

  const menuNotesModal = /^bc:omn:([0-9a-f-]{36}):([A-Z0-9_]{1,24}):v([1-9][0-9]*)$/u.exec(customId);
  if (menuNotesModal)
    return {
      area: 'order-menu-notes-modal',
      orderId: menuNotesModal[1]!,
      game: menuNotesModal[2]!,
      expectedVersion: Number(menuNotesModal[3])
    };
  const menuNotesOpen = /^bc:omno:([0-9a-f-]{36}):([A-Z0-9_]{1,24}):v([1-9][0-9]*)$/u.exec(customId);
  if (menuNotesOpen)
    return {
      area: 'order-menu-notes-open',
      orderId: menuNotesOpen[1]!,
      game: menuNotesOpen[2]!,
      expectedVersion: Number(menuNotesOpen[3])
    };

  const notesModal = /^bc:modal:order-notes:([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if (notesModal) {
    return {
      area: 'order-notes-modal',
      orderId: notesModal[1],
      expectedVersion: Number.parseInt(notesModal[2], 10)
    };
  }
  const notesOpen = /^bc:modal-open:order-notes:([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if (notesOpen)
    return {
      area: 'order-notes-open',
      orderId: notesOpen[1]!,
      expectedVersion: Number(notesOpen[2])
    };
  const requirementNoteModal = /^bc:rnm:([0-9a-f-]{36}):([0-9a-f-]{36}):v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(customId);
  if (requirementNoteModal)
    return {
      area: 'requirement-note-modal',
      orderId: requirementNoteModal[1]!,
      requirementId: requirementNoteModal[2]!,
      expectedVersion: Number(requirementNoteModal[3]),
      expectedRequirementVersion: Number(requirementNoteModal[4])
    };
  const requirementNoteOpen = /^bc:rno:([0-9a-f-]{36}):([0-9a-f-]{36}):v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(customId);
  if (requirementNoteOpen)
    return {
      area: 'requirement-note-open',
      orderId: requirementNoteOpen[1]!,
      requirementId: requirementNoteOpen[2]!,
      expectedVersion: Number(requirementNoteOpen[3]),
      expectedRequirementVersion: Number(requirementNoteOpen[4])
    };
  return null;
}
