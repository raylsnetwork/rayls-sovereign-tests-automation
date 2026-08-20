import { ethers } from 'hardhat';
import { expect } from 'chai';
import {
  DEPLOYMENT_PROXY_REGISTRY_ADDRESS,
  GOVERNANCE_API_URL,
  MINUTE,
  PRIVATE_KEY_SYSTEM,
  PROVIDER,
  ZERO_ADDRESS,
} from '../../../src/config/env-config';
import { ParticipantRole, ParticipantStatus, ParticipantRoleString } from '../../../src/enums/ParticipantEnums';
import { Participant } from '../../../src/types';
import { eventually } from '../../../src/utils/common';
import { GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_SHORT } from './governance-assertions';
import GovernanceController from '../../../src/api/GovernanceController';
import { DeploymentProxyRegistryV1__factory, ParticipantStorageV1__factory } from '../../../typechain-types';
import { formatFactoryName } from '../../../src/utils/formatters';

let participantsArray: Participant[] = [];
let participantStorage: any;
let participantID: any;
let participant: Participant;
const randomNum = Math.floor(Math.random() * 9000) + 1000;

const participantChainID = BigInt(randomNum);
const participantRole = ParticipantRole.participant;
const participantOwnerID = ZERO_ADDRESS;
const participantName = `QA Test ${randomNum}`;

const STATUS_TO_NUM: { [status: string]: number } = {
  new: 0,
  active: 1,
  inactive: 2,
  frozen: 3,
};

describe('Add Participant on chain and assert the response body based on Query Parameters passed', function () {
  const GovController = new GovernanceController(GOVERNANCE_API_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY_SYSTEM, PROVIDER['PNH']);

  before(async function () {
    this.timeout(MINUTE)
    const deploymentRegistry = await ethers.getContractAt(
      formatFactoryName(DeploymentProxyRegistryV1__factory),
      DEPLOYMENT_PROXY_REGISTRY_ADDRESS['PNH'],
      signer
    );
    const participantStorageAddress = await deploymentRegistry.getContract('ParticipantStorage');
    participantStorage = await ethers.getContractAt(
      formatFactoryName(ParticipantStorageV1__factory),
      participantStorageAddress,
      signer
    );

    const participantData = {
      chainId: participantChainID,
      role: participantRole,
      ownerId: participantOwnerID,
      name: participantName,
      allowedToBroadcast: true,
    };
    const tx = await participantStorage.addParticipant(participantData);
    await tx.wait(3);
  });

  it('Should add a participant on chain and assert the API response for the participant added @smoke', async () => {
    participant = await eventually({
      check: async () => {
        participantsArray = await GovController.getParticipants({ name: participantName });
        return participantsArray[0];
      },
      interval: 10000,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for participant "${participantName}"`,
    });

    expect(participant.status).to.equal(ParticipantStatus.NEW);
    expect(participant.name).to.equal(participantName);
    participantID = participant.id;
  });

  it(`Should update the status of the Participant added and assert the response body`, async () => {
    const targetStatus = ParticipantStatus.ACTIVE;
    const targetStatusNum = STATUS_TO_NUM[targetStatus];
    const updateStatus = await participantStorage.updateStatus(participantChainID, targetStatusNum);
    await updateStatus.wait(3);
    await eventually({
      check: async () => {
        participantsArray = await GovController.getParticipants({ name: participantName });
        return participantsArray[0].status === ParticipantStatus.ACTIVE;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for participant "${participantName}" → ACTIVE`,
    });
    participant = participantsArray[0];
    expect(participant.name).to.equal(participantName);
    expect(participant.id).to.equal(participantID);
    expect(participant.status).to.equal(targetStatus);
  });

  it(`Should freeze the Participant added and assert the response body`, async () => {
    const targetStatusNum = STATUS_TO_NUM[ParticipantStatus.FROZEN];
    const freezeTx = await participantStorage.updateStatus(participantChainID, targetStatusNum);
    await freezeTx.wait(3);
    await eventually({
      check: async () => {
        participantsArray = await GovController.getParticipants({ name: participantName });
        return participantsArray[0].status === ParticipantStatus.FROZEN;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for participant "${participantName}" → FROZEN`,
    });
    participant = participantsArray[0];
    expect(participant.name).to.equal(participantName);
    expect(participant.id).to.equal(participantID);
    expect(participant.status).to.equal(ParticipantStatus.FROZEN);
  });

  it(`Should update the role of the Participant added and assert the response body`, async () => {
    const newRole = ParticipantRole.issuer;
    const updateRoleTx = await participantStorage.updateRole(participantChainID, newRole);
    const receipt = await updateRoleTx.wait();
    expect(receipt.status).to.equal(1);
    await eventually<boolean>({
      check: async () => {
        participantsArray = await GovController.getParticipants({ name: participantName });
        return participantsArray[0].role == ParticipantRoleString.ISSUER;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for participant "${participantName}" role → ISSUER (chain=${participantChainID})`,
    });

    const updatedParticipant = participantsArray[0];
    expect(updatedParticipant).to.have.property('name').to.equal(participantName);
    expect(updatedParticipant.id).to.equal(participantID);
    expect(updatedParticipant.role).to.equal(ParticipantRoleString.ISSUER);
  });

  it(`Should fetch participants by role: Auditor`, async () => {
    participantsArray = await GovController.getParticipants({ role: ParticipantRoleString.AUDITOR });

    expect(participantsArray, 'Expected at least one auditor participant').to.not.be.empty;
    participantsArray.forEach(p => {
      expect(p.role).to.equal(ParticipantRoleString.AUDITOR);
    });
  });

  it(`Should fetch participants by status: ACTIVE`, async () => {
    participantsArray = await GovController.getParticipants({ status: ParticipantStatus.ACTIVE });

    expect(participantsArray, 'Expected at least one active participant').to.not.be.empty;
    participantsArray.forEach(p => {
      expect(p.status).to.equal(ParticipantStatus.ACTIVE);
    });
  });

  it(`Should fetch participants by chainID: 999`, async () => {
    participantsArray = await GovController.getParticipants({ chainId: 999 });

    expect(participantsArray, 'Expected at least one participant with chainId 999').to.not.be.empty;
    const result = participantsArray[0];
    expect(result.chainId).to.equal(999);
  });

  it(`Should fetch participants by role: Issuer ; status: ACTIVE`, async () => {
    participantsArray = await GovController.getParticipants({
      role: ParticipantRoleString.ISSUER,
      status: ParticipantStatus.ACTIVE,
    });

    expect(participantsArray, 'Expected at least one active issuer participant').to.not.be.empty;
    participantsArray.forEach((p: Participant) => {
      expect(p.role).to.equal(ParticipantRoleString.ISSUER);
      expect(p.status).to.equal(ParticipantStatus.ACTIVE);
    });
  });
});
