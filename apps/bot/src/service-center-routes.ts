export type ServiceCenterRoute =
  | {
      area: 'entry';
      action: 'create-order' | 'service-center' | 'player-workbench';
    }
  | { area: 'service-center-action'; action: 'commissions' | 'recharge' }
  | { area: 'order-open'; orderId: string }
  | {
      area: 'support-rating';
      orderId: string;
      score: number | null;
      reason: string | null;
    }
  | { area: 'support-rating-comment'; orderId: string; score: 1 | 2 }
  | {
      area: 'cancellation-action';
      action: 'confirm';
      orderId: string;
      previewId: string;
      expectedVersion: number;
    }
  | {
      area: 'order-select';
      orderId: string;
      field: 'catalog' | 'duration' | 'preferred-players';
      expectedVersion: number;
    }
  | {
      area: 'order-requirement-select';
      orderId: string;
      action: 'add' | 'preview';
      requirementId?: undefined;
      expectedVersion: number;
    }
  | {
      area: 'order-requirement-select';
      orderId: string;
      action: 'edit';
      requirementId?: undefined;
      expectedVersion: number;
      cursor?: string;
    }
  | {
      area: 'order-requirement-select';
      orderId: string;
      action: 'project' | 'units' | 'players';
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'order-requirement-action';
      orderId: string;
      action: 'back';
      expectedVersion: number;
    }
  | {
      area: 'order-requirement-action';
      orderId: string;
      action: 'page';
      expectedVersion: number;
      cursor?: string;
    }
  | {
      area: 'order-requirement-action';
      orderId: string;
      action: 'remove';
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'order-requirement-add-action';
      orderId: string;
      serviceCatalogVersionId: string;
      action: 'add';
      expectedVersion: number;
    }
  | { area: 'service-package-select'; orderId: string; expectedVersion: number }
  | { area: 'order-game-select'; orderId: string; expectedVersion: number }
  | {
      area: 'order-game-action';
      orderId: string;
      game: string;
      action: 'open';
      expectedVersion: number;
    }
  | {
      area: 'service-package-action';
      orderId: string;
      action: 'open' | 'back';
      expectedVersion: number;
    }
  | {
      area: 'service-package-action';
      orderId: string;
      action: 'preview';
      servicePackageVersionId: string;
      expectedVersion: number;
    }
  | {
      area: 'service-package-action';
      orderId: string;
      action: 'apply';
      servicePackageVersionId: string;
      expectedVersion: number;
    }
  | {
      area: 'order-action';
      orderId: string;
      action: 'submit' | 'submit-final' | 'cancel' | 'refresh';
      expectedVersion: number;
    }
  | {
      area: 'service-action';
      orderId: string;
      action: 'ready' | 'request-completion' | 'confirm' | 'support';
      expectedVersion: number;
    }
  | { area: 'order-notes-modal'; orderId: string; expectedVersion: number }
  | { area: 'order-notes-open'; orderId: string; expectedVersion: number }
  | {
      area: 'requirement-note-modal';
      orderId: string;
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'requirement-note-open';
      orderId: string;
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'profile';
      action: 'open' | 'refresh' | 'orders' | 'consumptions';
      cursor?: string;
    }
  | { area: 'reports'; action: 'list'; cursor?: string }
  | { area: 'gift'; action: 'open'; orderId: string; expectedVersion: number }
  | {
      area: 'gift';
      action: 'select' | 'refresh' | 'confirm' | 'back';
      token: string;
    }
  | {
      area: 'gift-recipient-select';
      orderId: string;
      expectedVersion: number;
      page: number;
      selection: string;
    }
  | { area: 'gift-catalog-select'; selection: string }
  | {
      area: 'gift-recipient-page';
      orderId: string;
      expectedVersion: number;
      page: number;
      selection: string;
    }
  | { area: 'reports'; action: 'detail'; reportId: string }
  | { area: 'unknown' };

export function parseServiceCenterCustomId(customId: string): ServiceCenterRoute {
  const ratingStart = /^bc:support-rating:([0-9a-f-]{36}):start$/u.exec(customId);
  if (ratingStart)
    return {
      area: 'support-rating',
      orderId: ratingStart[1]!,
      score: null,
      reason: null
    };
  const rating = /^bc:support-rating:([0-9a-f-]{36}):s([1-5])(?::r([A-Z_]+))?$/u.exec(customId);
  if (rating)
    return {
      area: 'support-rating',
      orderId: rating[1]!,
      score: Number(rating[2]),
      reason: rating[3] ?? null
    };
  const ratingComment = /^bc:support-rating-comment:([0-9a-f-]{36}):s([12])$/u.exec(customId);
  if (ratingComment)
    return {
      area: 'support-rating-comment',
      orderId: ratingComment[1]!,
      score: Number(ratingComment[2]) as 1 | 2
    };
  const giftOpen = /^bc:gift:open:([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if (giftOpen)
    return {
      area: 'gift',
      action: 'open',
      orderId: giftOpen[1]!,
      expectedVersion: Number(giftOpen[2])
    };
  const giftAction = /^bc:gift:(select|refresh|confirm|back):(g1_[A-Za-z0-9_-]{80})$/u.exec(customId);
  if (giftAction)
    return {
      area: 'gift',
      action: giftAction[1] as 'select' | 'refresh' | 'confirm' | 'back',
      token: giftAction[2]!
    };
  const giftRecipients = /^bc:grs:([0-9a-f-]{36}):([0-9]+):v([1-9][0-9]*):([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftRecipients)
    return {
      area: 'gift-recipient-select',
      orderId: giftRecipients[1]!,
      page: Number(giftRecipients[2]),
      expectedVersion: Number(giftRecipients[3]),
      selection: giftRecipients[4]!
    };
  const giftCatalog = /^bc:gc:([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftCatalog) return { area: 'gift-catalog-select', selection: giftCatalog[1]! };
  const giftRecipientPage = /^bc:grp:([0-9a-f-]{36}):([0-9]+):v([1-9][0-9]*):([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftRecipientPage)
    return {
      area: 'gift-recipient-page',
      orderId: giftRecipientPage[1]!,
      page: Number(giftRecipientPage[2]),
      expectedVersion: Number(giftRecipientPage[3]),
      selection: giftRecipientPage[4]!
    };
  if (customId === 'bc:profile:open' || customId === 'bc:profile:refresh') {
    return {
      area: 'profile',
      action: customId.endsWith('refresh') ? 'refresh' : 'open'
    };
  }
  const profilePage = /^bc:profile:(orders|consumptions):(first|end|c1_[A-Za-z0-9_-]{20,70})$/u.exec(customId);
  if (profilePage) {
    return {
      area: 'profile',
      action: profilePage[1] as 'orders' | 'consumptions',
      cursor: profilePage[2] === 'first' || profilePage[2] === 'end' ? undefined : profilePage[2]
    };
  }
  const reportList = /^bc:reports:list:(first|end|c1_[A-Za-z0-9_-]{20,70})$/u.exec(customId);
  if (reportList) {
    return {
      area: 'reports',
      action: 'list',
      cursor: reportList[1] === 'first' || reportList[1] === 'end' ? undefined : reportList[1]
    };
  }
  const reportDetail = /^bc:reports:detail:([0-9a-f-]{36})$/u.exec(customId);
  if (reportDetail) return { area: 'reports', action: 'detail', reportId: reportDetail[1] };
  if (customId === 'bc:entry:create-order') {
    return { area: 'entry', action: 'create-order' };
  }
  if (customId === 'bc:entry:service-center') {
    return { area: 'entry', action: 'service-center' };
  }
  if (customId === 'bc:entry:player-workbench') {
    return { area: 'entry', action: 'player-workbench' };
  }
  if (customId === 'bc:service-center:commissions' || customId === 'bc:service-center:recharge') {
    return {
      area: 'service-center-action',
      action: customId.endsWith('commissions') ? 'commissions' : 'recharge'
    };
  }
  const orderOpen = /^bc:order:([0-9a-f-]{36}):open$/u.exec(customId);
  if (orderOpen) return { area: 'order-open', orderId: orderOpen[1]! };

  const cancellationAction = /^bc:cancel:([0-9a-f-]{36}):([0-9a-f-]{36}):confirm:v([1-9][0-9]*)$/u.exec(customId);
  if (cancellationAction) {
    return {
      area: 'cancellation-action',
      action: 'confirm',
      orderId: cancellationAction[1],
      previewId: cancellationAction[2],
      expectedVersion: Number.parseInt(cancellationAction[3], 10)
    };
  }

  const orderSelect = /^bc:select:order:([0-9a-f-]{36}):(catalog|duration|preferred-players):v([1-9][0-9]*)$/u.exec(
    customId
  );
  if (orderSelect) {
    return {
      area: 'order-select',
      orderId: orderSelect[1],
      field: orderSelect[2] as 'catalog' | 'duration' | 'preferred-players',
      expectedVersion: Number.parseInt(orderSelect[3], 10)
    };
  }

  const requirementAdd = /^bc:req:([0-9a-f-]{36}):(add|preview):v([1-9][0-9]*)$/u.exec(customId);
  if (requirementAdd)
    return {
      area: 'order-requirement-select',
      orderId: requirementAdd[1]!,
      action: requirementAdd[2] as 'add' | 'preview',
      expectedVersion: Number(requirementAdd[3])
    };
  const requirementEdit = /^bc:req:([0-9a-f-]{36}):edit:(first|[A-Za-z0-9_-]{1,40}):v([1-9][0-9]*)$/u.exec(customId);
  if (requirementEdit)
    return {
      area: 'order-requirement-select',
      orderId: requirementEdit[1]!,
      action: 'edit',
      cursor: requirementEdit[2] === 'first' ? undefined : requirementEdit[2],
      expectedVersion: Number(requirementEdit[3])
    };
  const requirementQuantity =
    /^bc:req:([0-9a-f-]{36}):([0-9a-f-]{36}):(project|units|players):v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(customId);
  if (requirementQuantity) {
    return {
      area: 'order-requirement-select',
      orderId: requirementQuantity[1]!,
      requirementId: requirementQuantity[2]!,
      action: requirementQuantity[3] as 'project' | 'units' | 'players',
      expectedVersion: Number(requirementQuantity[4]),
      expectedRequirementVersion: Number(requirementQuantity[5])
    };
  }
  const requirementRemove = /^bc:req:([0-9a-f-]{36}):([0-9a-f-]{36}):remove:v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(
    customId
  );
  if (requirementRemove)
    return {
      area: 'order-requirement-action',
      orderId: requirementRemove[1]!,
      requirementId: requirementRemove[2]!,
      action: 'remove',
      expectedVersion: Number(requirementRemove[3]),
      expectedRequirementVersion: Number(requirementRemove[4])
    };
  const requirementAddAction = /^bc:req:([0-9a-f-]{36}):([0-9a-f-]{36}):add:v([1-9][0-9]*)$/u.exec(customId);
  if (requirementAddAction)
    return {
      area: 'order-requirement-add-action',
      orderId: requirementAddAction[1]!,
      serviceCatalogVersionId: requirementAddAction[2]!,
      action: 'add',
      expectedVersion: Number(requirementAddAction[3])
    };
  const requirementBack = /^bc:req:([0-9a-f-]{36}):back:v([1-9][0-9]*)$/u.exec(customId);
  if (requirementBack)
    return {
      area: 'order-requirement-action',
      orderId: requirementBack[1]!,
      action: 'back',
      expectedVersion: Number(requirementBack[2])
    };
  const requirementPage = /^bc:req:([0-9a-f-]{36}):page:(first|[A-Za-z0-9_-]{1,40}):v([1-9][0-9]*)$/u.exec(customId);
  if (requirementPage)
    return {
      area: 'order-requirement-action',
      orderId: requirementPage[1]!,
      action: 'page',
      cursor: requirementPage[2] === 'first' ? undefined : requirementPage[2],
      expectedVersion: Number(requirementPage[3])
    };

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

  const orderAction = /^bc:order:([0-9a-f-]{36}):(submit|submit-final|cancel|refresh):v([1-9][0-9]*)$/u.exec(customId);
  if (orderAction) {
    return {
      area: 'order-action',
      orderId: orderAction[1],
      action: orderAction[2] as 'submit' | 'submit-final' | 'cancel' | 'refresh',
      expectedVersion: Number.parseInt(orderAction[3], 10)
    };
  }

  const serviceAction = /^bc:service:(ready|request-completion|confirm|support):([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(
    customId
  );
  if (serviceAction) {
    return {
      area: 'service-action',
      orderId: serviceAction[2],
      action: serviceAction[1] as 'ready' | 'request-completion' | 'confirm' | 'support',
      expectedVersion: Number.parseInt(serviceAction[3], 10)
    };
  }

  return { area: 'unknown' };
}
