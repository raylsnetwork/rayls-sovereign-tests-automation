import { ParticipantStatus, ParticipantRoleString } from '../enums/ParticipantEnums';

export interface ParticipantsByQueryParameters {
  name?: string;
  chainId?: number;
  status?: string;
  role?: ParticipantRoleString;
  createdAfter?: string;
  createdBefore?: string;
}

export interface Participant {
  id: string;
  chainId: number;
  name: string;
  ownerId: string;
  role: ParticipantRoleString;
  status: ParticipantStatus;
  allowedToBroadcast: boolean;
  isFlagged: boolean;
  flagReason?: string;
  flaggedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ParticipantResponse = Participant[];