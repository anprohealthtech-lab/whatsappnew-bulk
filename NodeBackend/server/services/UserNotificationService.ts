import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { userNotificationRecipients } from "@shared/schema";

type TenantContext = {
  organizationId: string;
  userId: string;
};

type EventType = "lead_created" | "demo_scheduled" | "booking_confirmed";

type NotificationPayload = {
  title: string;
  lines: string[];
};

const EVENT_COLUMN_MAP = {
  lead_created: userNotificationRecipients.notifyOnLeadCreated,
  demo_scheduled: userNotificationRecipients.notifyOnDemoScheduled,
  booking_confirmed: userNotificationRecipients.notifyOnBookingConfirmed,
} as const;

function normalizePhone(phoneNumber: string): string {
  return String(phoneNumber || "").replace(/\D/g, "");
}

function buildMessage(payload: NotificationPayload): string {
  return [payload.title, ...payload.lines.filter(Boolean)].join("\n");
}

export async function getNotificationRecipientsForEvent(
  tenant: TenantContext,
  eventType: EventType,
) {
  const eventColumn = EVENT_COLUMN_MAP[eventType];
  return db
    .select()
    .from(userNotificationRecipients)
    .where(
      and(
        eq(userNotificationRecipients.organizationId, tenant.organizationId),
        eq(userNotificationRecipients.userId, tenant.userId),
        eq(userNotificationRecipients.isActive, "true"),
        eq(eventColumn, "true"),
      ),
    )
    .orderBy(desc(userNotificationRecipients.createdAt));
}

export async function sendNotificationForEvent(
  tenant: TenantContext,
  whatsappService: { sendTextMessage(phoneNumber: string, message: string): Promise<any> },
  eventType: EventType,
  payload: NotificationPayload,
): Promise<void> {
  const recipients = await getNotificationRecipientsForEvent(tenant, eventType);
  if (!recipients.length) return;

  const message = buildMessage(payload);

  for (const recipient of recipients) {
    const phoneNumber = normalizePhone(recipient.phoneNumber);
    if (!phoneNumber) continue;

    try {
      await whatsappService.sendTextMessage(phoneNumber, message);
    } catch (error) {
      console.error(
        `[UserNotificationService] Failed to send ${eventType} notification to ${phoneNumber}:`,
        error,
      );
    }
  }
}
