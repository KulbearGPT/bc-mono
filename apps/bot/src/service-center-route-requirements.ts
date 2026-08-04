import type { ServiceCenterRoute } from './service-center-routes.js';

export function parseRequirementsRoute(customId: string): ServiceCenterRoute | null {
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
  return null;
}
