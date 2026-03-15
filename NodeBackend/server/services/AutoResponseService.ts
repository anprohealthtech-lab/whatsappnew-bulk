import type { IStorage, TenantFilter } from '../storage';
import type { WAServiceInstance } from './WhatsAppSessionManager';
import { log } from '../utils';

export class AutoResponseService {
  constructor(
    private storage: IStorage,
    private tenantContext: TenantFilter,
    private whatsAppService: WAServiceInstance | null = null,
  ) {}

  /**
   * Check if incoming message matches any keywords and send auto-response
   */
  async handleIncomingMessage(phoneNumber: string, messageText: string): Promise<boolean> {
    try {
      if (!this.whatsAppService) {
        log('AutoResponseService: No WhatsApp service set, skipping auto-response');
        return false;
      }

      const autoResponses = await this.storage.getAutoResponsesByTenant(this.tenantContext);
      
      for (const response of autoResponses) {
        const keyword = response.keyword.toUpperCase();
        const msgUpper = messageText.trim().toUpperCase();
        
        // Check if message contains or matches the keyword
        if (msgUpper.includes(keyword) || msgUpper === keyword) {
          log(`🤖 Auto-responding to keyword "${keyword}" from ${phoneNumber}`);
          
          // Send auto-response
          await this.whatsAppService.sendTextMessage(phoneNumber, response.response);
          
          // Save auto-response to database
          await this.storage.createMessage({
            organizationId: this.tenantContext.organizationId,
            userId: this.tenantContext.userId,
            phoneNumber,
            content: response.response,
            type: 'text',
            status: 'sent',
          });

          return true; // Response sent
        }
      }
      
      return false; // No matching keyword
    } catch (error) {
      log(`Error handling auto-response: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }
}
