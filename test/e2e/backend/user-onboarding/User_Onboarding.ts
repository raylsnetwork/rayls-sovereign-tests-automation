import {
  BACKEND_OPS_URL,
  BACKEND_OPERATOR_AUTH_KEY,
  BACKEND_USER_AUTH_KEY,
} from '../../../../src/config/env-config';
import {
  findAddressPair as findPair,
  onboardUser,
  onboardUserAndUpdateStatus,
  updateOnboardingStatus,
} from '../../../../src/flows/backend/user-onboarding';
import { OperatorController, UserController } from '../../../../src/api';
import { expect } from 'chai';
import { OnboardingStatus } from '../../../../src/enums/OnboardingStatus';

describe('E2E Tests: User Onboarding @backend @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);

  it('Should onboard and approve user @smoke', async function (this: Mocha.Context) {
    const pair = await onboardUser(userController);
    expect(pair.status).to.be.equal(OnboardingStatus.PENDING);

    await updateOnboardingStatus(operatorController, pair, OnboardingStatus.APPROVED);

    const myPairs = await userController.listMyAddressPairs();
    const approved = findPair(myPairs, pair);
    expect(approved, 'approved pair should be listed').to.not.be.undefined;
    expect(approved!.status).to.be.equal(OnboardingStatus.APPROVED);
  });

  it('Should onboard and reject user @smoke', async function (this: Mocha.Context) {
    const pair = await onboardUserAndUpdateStatus(userController, operatorController, OnboardingStatus.REJECTED);

    const myPairs = await userController.listMyAddressPairs();
    expect(findPair(myPairs, pair), 'rejected pair must not be listed').to.be.undefined;
  });

  it('Should onboard, approve, then reject the same pair', async function (this: Mocha.Context) {
    const pair = await onboardUser(userController);

    // Capture the userId while the pair is still pending — once it leaves PENDING it drops out of the
    // admin discovery list, so the second transition can only target it by the cached id.
    const userId = await updateOnboardingStatus(operatorController, pair, OnboardingStatus.APPROVED);
    expect(findPair(await userController.listMyAddressPairs(), pair)?.status).to.be.equal(OnboardingStatus.APPROVED);

    await updateOnboardingStatus(operatorController, pair, OnboardingStatus.REJECTED, { userId });
    expect(findPair(await userController.listMyAddressPairs(), pair), 'rejected pair must not be listed').to.be
      .undefined;
  });

  it('Should onboard same user twice and generate different address pairs', async function (this: Mocha.Context) {
    const pair1 = await onboardUser(userController);
    const pair2 = await onboardUser(userController);

    expect(pair1.private_chain_address).not.to.be.equal(pair2.private_chain_address);
    expect(pair1.public_chain_address).not.to.be.equal(pair2.public_chain_address);
  });
});
