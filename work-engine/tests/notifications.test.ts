import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import {
  createNotification,
  getNotification,
  dismissNotification,
  listUndismissedNotifications,
  listAllNotifications,
  dismissAllNotifications,
} from '../src/db/notifications';

describe('Notifications data layer', () => {
  let client: DynamoDBDocumentClient;
  let port: number;

  before(async () => {
    port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('createNotification returns a notification with id, createdAt, dismissed=false', async () => {
    const notification = await createNotification(client, {
      message: 'Newsletter bundle auto-created for Mar 15',
      bundleId: 'bundle-123',
      templateId: 'template-456',
    });

    assert.ok(notification.id);
    assert.ok(notification.createdAt);
    assert.strictEqual(notification.message, 'Newsletter bundle auto-created for Mar 15');
    assert.strictEqual(notification.bundleId, 'bundle-123');
    assert.strictEqual(notification.dismissed, false);
    assert.strictEqual((notification as Record<string, unknown>).PK, undefined);
    assert.strictEqual((notification as Record<string, unknown>).SK, undefined);
  });

  it('getNotification returns the notification by id', async () => {
    const created = await createNotification(client, {
      message: 'Test notification',
    });
    const fetched = await getNotification(client, created.id);

    assert.ok(fetched);
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.message, 'Test notification');
    assert.strictEqual(fetched.dismissed, false);
  });

  it('getNotification returns null for non-existent id', async () => {
    const result = await getNotification(client, 'does-not-exist');
    assert.strictEqual(result, null);
  });

  it('dismissNotification sets dismissed to true', async () => {
    const created = await createNotification(client, {
      message: 'Dismiss me',
    });

    const dismissed = await dismissNotification(client, created.id);
    assert.ok(dismissed);
    assert.strictEqual(dismissed.dismissed, true);

    // Verify via get
    const fetched = await getNotification(client, created.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.dismissed, true);
  });

  it('listUndismissedNotifications returns only undismissed notifications', async () => {
    // Create two notifications
    const n1 = await createNotification(client, {
      message: 'Active notification',
    });
    const n2 = await createNotification(client, {
      message: 'Dismissed notification',
    });

    // Dismiss the second one
    await dismissNotification(client, n2.id);

    const notifications = await listUndismissedNotifications(client);
    const ids = notifications.map((n) => n.id);

    assert.ok(ids.includes(n1.id), 'should contain the active notification');
    assert.ok(!ids.includes(n2.id), 'should not contain the dismissed notification');
  });

  it('listUndismissedNotifications returns most recent first', async () => {
    // Create notifications with a small delay
    const n1 = await createNotification(client, {
      message: 'First',
    });

    await new Promise((r) => setTimeout(r, 10));

    const n2 = await createNotification(client, {
      message: 'Second',
    });

    const notifications = await listUndismissedNotifications(client);

    // Find the indices of our two notifications
    const idx1 = notifications.findIndex((n) => n.id === n1.id);
    const idx2 = notifications.findIndex((n) => n.id === n2.id);

    assert.ok(idx1 >= 0, 'should contain first notification');
    assert.ok(idx2 >= 0, 'should contain second notification');
    assert.ok(idx2 < idx1, 'second (more recent) should come before first');
  });

  it('listAllNotifications returns both dismissed and undismissed', async () => {
    const n1 = await createNotification(client, { message: 'ListAll active' });
    const n2 = await createNotification(client, { message: 'ListAll dismissed' });
    await dismissNotification(client, n2.id);

    const all = await listAllNotifications(client);
    const ids = all.map((n) => n.id);

    assert.ok(ids.includes(n1.id), 'should contain active notification');
    assert.ok(ids.includes(n2.id), 'should contain dismissed notification');
  });

  it('listAllNotifications returns undismissed before dismissed', async () => {
    // Clear-ish: create fresh ones with specific timing
    const nDismissed = await createNotification(client, { message: 'ListAll ordering dismissed' });
    await new Promise((r) => setTimeout(r, 10));
    const nActive = await createNotification(client, { message: 'ListAll ordering active' });

    await dismissNotification(client, nDismissed.id);

    const all = await listAllNotifications(client);
    const idxDismissed = all.findIndex((n) => n.id === nDismissed.id);
    const idxActive = all.findIndex((n) => n.id === nActive.id);

    assert.ok(idxActive >= 0, 'should contain active notification');
    assert.ok(idxDismissed >= 0, 'should contain dismissed notification');
    assert.ok(idxActive < idxDismissed, 'undismissed should come before dismissed');
  });

  it('dismissAllNotifications dismisses all undismissed and returns count', async () => {
    // Create 2 fresh undismissed notifications
    const na = await createNotification(client, { message: 'DismissAll test A' });
    const nb = await createNotification(client, { message: 'DismissAll test B' });

    // Also create a pre-dismissed one
    const nc = await createNotification(client, { message: 'DismissAll test C already dismissed' });
    await dismissNotification(client, nc.id);

    // Get undismissed count before
    const beforeList = await listUndismissedNotifications(client);
    const beforeIds = new Set(beforeList.map((n) => n.id));
    assert.ok(beforeIds.has(na.id), 'na should be undismissed before');
    assert.ok(beforeIds.has(nb.id), 'nb should be undismissed before');

    const count = await dismissAllNotifications(client);

    // count should be at least 2 (na + nb)
    assert.ok(count >= 2, 'should have dismissed at least 2 notifications');

    // After: all undismissed should now be dismissed
    const afterUndismissed = await listUndismissedNotifications(client);
    const afterIds = afterUndismissed.map((n) => n.id);
    assert.ok(!afterIds.includes(na.id), 'na should now be dismissed');
    assert.ok(!afterIds.includes(nb.id), 'nb should now be dismissed');
  });

  it('dismissAllNotifications returns 0 when nothing to dismiss', async () => {
    // Dismiss everything first
    await dismissAllNotifications(client);
    // Now dismiss again — should return 0
    const count = await dismissAllNotifications(client);
    assert.strictEqual(count, 0);
  });
});
