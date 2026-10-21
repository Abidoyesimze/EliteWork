/**
 * Dispute Resolution E2E suite — Amana Mobile
 *
 * Exercises the end-to-end dispute resolution flow:
 *   1. User views a trade in IN_TRANSIT status
 *   2. User taps "Initiate Dispute" and submits a reason
 *   3. Trade transitions to DISPUTED status
 *   4. User navigates to Evidence Capture screen
 *   5. User selects video evidence type and simulates capture
 *   6. User uploads evidence
 *   7. Evidence upload completes successfully
 *
 * This suite runs against the Expo dev-client build on both Android emulator
 * and iOS simulator (see .detoxrc.js for device configs).
 *
 * The mock server (e2e/helpers/mockServer.ts) must be running before the
 * test; it is started by globalSetup via jest.config.js.
 */

import { device, element, by, expect as detoxExpect, waitFor } from 'detox';
import { mockAuthLaunchArgs } from './helpers/auth';
import { resetTradeState } from './helpers/mockServer';

const TIMEOUT = 20_000; // ms — generous for emulator cold-start

const TRADE_ID_DISPUTE = 'TRD-E2E-0003'; // Fixture with DISPUTED status

describe('Dispute Resolution Flow', () => {
  beforeAll(async () => {
    await device.launchApp({
      newInstance: true,
      launchArgs: {
        ...mockAuthLaunchArgs(),
        E2E_API_BASE_URL: 'http://localhost:4001',
      },
      permissions: {
        notifications: 'YES',
      },
    });
  });

  beforeEach(async () => {
    resetTradeState();
    await device.reloadReactNative();
  });

  afterAll(async () => {
    await device.terminateApp();
  });

  it('initiates a dispute from TradeDetail screen', async () => {
    // Start from TradeList
    await waitFor(element(by.text('🌾 Trades')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap the trade that supports dispute (IN_TRANSIT status)
    await element(by.text('#TRD-E2E')).tap();

    // Wait for TradeDetail screen
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Verify the trade is in a disputable state (IN_TRANSIT)
    await waitFor(element(by.text('In Transit')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap "Initiate Dispute" button
    await element(by.text('⚠️ Initiate Dispute')).tap();

    // Dispute modal should appear
    await waitFor(element(by.text('Initiate Dispute')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    await waitFor(element(by.text('Describe the issue with this trade:')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Enter dispute reason
    await element(by.placeholder('e.g. Goods arrived damaged, quantity mismatch…'))
      .typeText('Goods arrived damaged - packages torn and wet');

    // Tap Submit
    await element(by.text('Submit')).tap();

    // Wait for dispute to be processed - trade should show DISPUTED status
    await waitFor(element(by.text('Disputed')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Timeline should show Disputed step as active
    await waitFor(element(by.text('Disputed')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
  });

  it('navigates to Evidence Capture and uploads video evidence', async () => {
    // Start from TradeList
    await waitFor(element(by.text('🌾 Trades')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap the disputed trade
    await element(by.text('#TRD-E2E')).tap();

    // Wait for TradeDetail screen
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Verify trade is in DISPUTED status
    await waitFor(element(by.text('Disputed')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap "Upload Evidence" button
    await element(by.text('📹 Upload Evidence')).tap();

    // Wait for EvidenceCapture screen
    await waitFor(element(by.text('Upload Evidence')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Verify trade reference is shown
    await waitFor(element(by.text(`Trade: #${TRADE_ID_DISPUTE.slice(0, 12)}…`)))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Select Video evidence type (should be default)
    await waitFor(element(by.text('Video')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap capture area to simulate video capture
    await element(by.text('Tap to record')).tap();

    // Alert appears - tap "Simulate Capture"
    await waitFor(element(by.text('Simulate Capture')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
    await element(by.text('Simulate Capture')).tap();

    // Should show captured preview with "Ready to upload"
    await waitFor(element(by.text('Ready to upload')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap Upload button
    await element(by.text('☁️ Upload Video')).tap();

    // Wait for upload to complete
    await waitFor(element(by.text('Evidence Uploaded')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Verify success message
    await waitFor(element(by.text('Your video has been submitted. A mediator will review it shortly.')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap "Back to Trade"
    await element(by.text('Back to Trade')).tap();

    // Should navigate back to TradeDetail
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
  });

  it('navigates to Evidence Capture and uploads photo evidence', async () => {
    // Start from TradeList
    await waitFor(element(by.text('🌾 Trades')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap the disputed trade
    await element(by.text('#TRD-E2E')).tap();

    // Wait for TradeDetail screen
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Verify trade is in DISPUTED status
    await waitFor(element(by.text('Disputed')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap "Upload Evidence" button
    await element(by.text('📹 Upload Evidence')).tap();

    // Wait for EvidenceCapture screen
    await waitFor(element(by.text('Upload Evidence')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Select Photo evidence type
    await element(by.text('📷')).tap();

    // Verify Photo type is selected
    await waitFor(element(by.text('Photo')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap capture area to simulate photo capture
    await element(by.text('Tap to capture')).tap();

    // Alert appears - tap "Simulate Capture"
    await waitFor(element(by.text('Simulate Capture')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
    await element(by.text('Simulate Capture')).tap();

    // Should show captured preview with "Ready to upload"
    await waitFor(element(by.text('Ready to upload')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap Upload button
    await element(by.text('☁️ Upload Photo')).tap();

    // Wait for upload to complete
    await waitFor(element(by.text('Evidence Uploaded')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Verify success message
    await waitFor(element(by.text('Your photo has been submitted. A mediator will review it shortly.')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap "Back to Trade"
    await element(by.text('Back to Trade')).tap();

    // Should navigate back to TradeDetail
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
  });

  it('cancels dispute initiation', async () => {
    // Start from TradeList
    await waitFor(element(by.text('🌾 Trades')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap the trade
    await element(by.text('#TRD-E2E')).tap();

    // Wait for TradeDetail screen
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap "Initiate Dispute" button
    await element(by.text('⚠️ Initiate Dispute')).tap();

    // Dispute modal should appear
    await waitFor(element(by.text('Initiate Dispute')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap Cancel
    await element(by.text('Cancel')).tap();

    // Modal should close, back to TradeDetail
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Trade status should still be IN_TRANSIT (not disputed)
    await waitFor(element(by.text('In Transit')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
  });

  it('retakes evidence before upload', async () => {
    // Start from TradeList
    await waitFor(element(by.text('🌾 Trades')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap the disputed trade
    await element(by.text('#TRD-E2E')).tap();

    // Wait for TradeDetail screen
    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap "Upload Evidence" button
    await element(by.text('📹 Upload Evidence')).tap();

    // Wait for EvidenceCapture screen
    await waitFor(element(by.text('Upload Evidence')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap capture area to simulate video capture
    await element(by.text('Tap to record')).tap();

    // Alert appears - tap "Simulate Capture"
    await waitFor(element(by.text('Simulate Capture')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
    await element(by.text('Simulate Capture')).tap();

    // Should show captured preview
    await waitFor(element(by.text('Ready to upload')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    // Tap Retake
    await element(by.text('↩ Retake')).tap();

    // Should return to capture placeholder
    await waitFor(element(by.text('Tap to record')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
  });

  it('shows error when upload fails', async () => {
    // This test requires a trade ID that will cause upload to fail
    // We'll use a non-existent trade ID
    await device.launchApp({
      newInstance: true,
      launchArgs: {
        ...mockAuthLaunchArgs(),
        E2E_API_BASE_URL: 'http://localhost:4001',
        E2E_FORCE_UPLOAD_ERROR: 'true',
      },
      permissions: {
        notifications: 'YES',
      },
    });

    await waitFor(element(by.text('🌾 Trades')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    await element(by.text('#TRD-E2E')).tap();

    await waitFor(element(by.text('Trade Detail')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    await element(by.text('📹 Upload Evidence')).tap();

    await waitFor(element(by.text('Upload Evidence')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    await element(by.text('Tap to record')).tap();

    await waitFor(element(by.text('Simulate Capture')))
      .toBeVisible()
      .withTimeout(TIMEOUT);
    await element(by.text('Simulate Capture')).tap();

    await waitFor(element(by.text('Ready to upload')))
      .toBeVisible()
      .withTimeout(TIMEOUT);

    await element(by.text('☁️ Upload Video')).tap();

    // Wait for error
    await waitFor(element(by.text(/Upload failed/)))
      .toBeVisible()
      .withTimeout(TIMEOUT);
  });
});