import { storage as defaultStorage, type IStorage, type TenantFilter } from '../storage';
import { AutomaticReplyGuard, AutomaticReplySuppressedError, type ReplyScope, type ReplyTransport } from '../automaticReplies/guard';
import { log } from '../utils';

export class AutoResponseService {
  private whatsAppService: ReplyTransport | null = null;

  constructor(
    private storage: IStorage = defaultStorage,
    private tenant?: TenantFilter,
    session?: ReplyTransport,
    private replyGuard?: { guard: AutomaticReplyGuard; scope: ReplyScope },
  ) {
    this.whatsAppService = session || null;
  }

  /** Set the WhatsApp service instance for sending responses */
  setWhatsAppService(service: ReplyTransport) {
    this.whatsAppService = service;
  }

  /**
   * Match an incoming keyword and send its response. True means handled,
   * including a deliberately suppressed repeat; false means no response matched.
   */
  async handleIncomingMessage(phoneNumber: string, messageText: string): Promise<boolean> {
    try {
      if (!this.whatsAppService) {
        log('AutoResponseService: No WhatsApp service set, skipping auto-response');
        return false;
      }

      const autoResponses = this.tenant
        ? await this.storage.getAutoResponsesByTenant(this.tenant)
        : await this.storage.getAutoResponses();
      
      for (const response of autoResponses) {
        const keyword = response.keyword.trim().toUpperCase();
        if (!keyword) continue;
        const msgUpper = messageText.trim().toUpperCase();
        
        // Check if message contains or matches the keyword
        if (msgUpper.includes(keyword) || msgUpper === keyword) {
          log(`🤖 Auto-responding to keyword "${keyword}" from ${phoneNumber}`);
          
          // A configured rule is a reply category even when its text has no
          // recognizable menu/identity wording. Consume it without falling
          // through when capped, otherwise another rule/bot could restart the loop.
          if (this.replyGuard && !await this.replyGuard.guard.claim(this.replyGuard.scope, [`keyword:${response.id}`])) {
            log(`AutoResponseService: repeat limit reached for rule ${response.id}`);
            return true;
          }

          // Send auto-response
          await this.whatsAppService.sendTextMessage(phoneNumber, response.response);
          
          // Save auto-response to database
          await this.storage.createMessage({
            ...this.tenant,
            phoneNumber,
            content: response.response,
            type: 'text',
            status: 'sent',
            metadata: { auto_response_id: response.id },
          });

          return true; // Response sent
        }
      }
      
      return false; // No matching keyword
    } catch (error) {
      if (error instanceof AutomaticReplySuppressedError) return true;
      log(`Error handling auto-response: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }
}

export const autoResponseService = new AutoResponseService();
