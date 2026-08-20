export enum ParticipantStatus {
  NEW = 'new',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  FROZEN = 'frozen',
}

export enum ParticipantRole {
  participant = 0,
  issuer = 1,
  auditor = 2,
}

export enum ParticipantRoleString {
  PARTICIPANT = 'participant',
  ISSUER = 'issuer',
  AUDITOR = 'auditor',
}
