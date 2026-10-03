/**
 * Host-owned Web Chat delivery seam.
 *
 * Web Chat is represented as a CLI messaging-group address so the normal
 * router can write the response to the originating session's outbound queue.
 * It is not a real CLI client, however, so the CLI adapter must not be called
 * for this destination. Keeping the predicate and receipt here makes the
 * optional WebQI/Web Chat overlay removable without spreading its platform
 * convention through the delivery layer.
 */

export const WEB_CHAT_CHANNEL_TYPE = 'cli';
export const WEB_CHAT_PLATFORM_PREFIX = 'web:';

export function isHostOwnedWebChatDestination(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): boolean {
  return (
    channelType === WEB_CHAT_CHANNEL_TYPE &&
    typeof platformId === 'string' &&
    platformId.startsWith(WEB_CHAT_PLATFORM_PREFIX) &&
    platformId.length > WEB_CHAT_PLATFORM_PREFIX.length
  );
}

/** A stable host receipt is enough to acknowledge the session outbox row. */
export function hostOwnedWebChatReceipt(messageId: string): string {
  return `web-chat:${messageId}`;
}
