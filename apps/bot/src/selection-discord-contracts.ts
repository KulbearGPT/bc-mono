export interface SelectionCandidate {
  id: string;
  playerDisplayName: string;
  playerDiscordUserId?: string;
  orderRequirementId: string;
  publicGameTags: string[];
  publicServiceTags: string[];
}
export type SelectionRoute =
  | {
      action: 'start';
      orderId: string;
      poolId: string | null;
      expectedPoolVersion: number | null;
      expectedOrderVersion: number;
    }
  | {
      action: 'apply';
      orderId: string;
      poolId: string;
      requirementId: string;
      expectedPoolVersion: number;
    }
  | {
      action: 'apply-menu';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number;
    }
  | {
      action: 'withdraw';
      orderId: string;
      poolId: string;
      applicationId: string;
      expectedPoolVersion: number;
      expectedApplicationVersion: number;
    }
  | {
      action: 'close';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number;
    }
  | {
      action: 'finalize';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number;
      expectedOrderVersion: number;
    }
  | {
      action: 'reselect';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number | null;
      expectedOrderVersion: number | null;
    }
  | {
      action: 'page';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number | null;
      expectedOrderVersion: number;
      pageIndex: number;
      legacyCursor?: string;
    }
  | { action: 'unknown' };
