import { storage } from '../storage';
import type { WhatsAppService } from './WhatsAppService';
import { type Message, type InsertMessage } from '@shared/schema';

export interface MessageStats {
  totalMessages: number;
  sentToday: number;
  deliveredToday: number;
  failedToday: number;
  pendingCount: number;
}

export class MessageService {
  private whatsAppService: WhatsAppService | null = null;

  /** Set the WhatsApp service instance (call before sending messages) */
  setWhatsAppService(service: WhatsAppService) {
    this.whatsAppService = service;
  }

  private getWA(): WhatsAppService {
    if (!this.whatsAppService) {
      throw new Error('WhatsApp service not set. Call setWhatsAppService() first or use a per-user session.');
    }
    return this.whatsAppService;
  }

  async sendTextMessage(phoneNumber: string, content: string): Promise<Message> {
    // Create message record in storage
    const messageData: InsertMessage = {
      phoneNumber,
      content,
      type: 'text',
      status: 'pending',
      fileUrl: null,
      fileName: null,
      fileSize: null,
      sampleId: null,
      metadata: null,
    };

    const message = await storage.createMessage(messageData);

    try {
      // Send via WhatsApp
      const whatsappResponse = await this.getWA().sendTextMessage(phoneNumber, content);
      
      // Update message status
      await storage.updateMessage(message.id, {
        status: 'sent',
        sentAt: new Date(),
        metadata: { whatsappId: whatsappResponse.id, whatsappTimestamp: whatsappResponse.timestamp },
      });

      // Log system activity
      await storage.createSystemLog({
        level: 'info',
        message: `Text message sent to ${phoneNumber}`,
        metadata: { messageId: message.id, whatsappId: whatsappResponse.id },
      });

      return await storage.getMessage(message.id) as Message;
    } catch (error: any) {
      // Update message status to failed
      await storage.updateMessage(message.id, {
        status: 'failed',
        metadata: { error: error?.message || 'Unknown error' },
      });

      // Log error
      await storage.createSystemLog({
        level: 'error',
        message: `Failed to send text message to ${phoneNumber}: ${error?.message || 'Unknown error'}`,
        metadata: { messageId: message.id, error: error?.message || 'Unknown error' },
      });

      throw error;
    }
  }

  async sendReportMessage(phoneNumber: string, filePath: string, fileName: string, fileSize: number, sampleId: string, content?: string): Promise<Message> {
    const messageContent = content || `Lab report for sample ${sampleId}`;
    
    const messageData: InsertMessage = {
      phoneNumber,
      content: messageContent,
      type: 'report',
      status: 'pending',
      fileUrl: filePath,
      fileName,
      fileSize,
      sampleId,
      metadata: null,
    };

    const message = await storage.createMessage(messageData);

    try {
      // Send via WhatsApp
      const whatsappResponse = await this.getWA().sendMediaMessage(phoneNumber, filePath, messageContent);
      
      // Update message status
      await storage.updateMessage(message.id, {
        status: 'sent',
        sentAt: new Date(),
        metadata: { whatsappId: whatsappResponse.id, whatsappTimestamp: whatsappResponse.timestamp },
      });

      // Log system activity
      await storage.createSystemLog({
        level: 'info',
        message: `Report sent to ${phoneNumber} for sample ${sampleId}`,
        metadata: { messageId: message.id, whatsappId: whatsappResponse.id, fileName, fileSize },
      });

      return await storage.getMessage(message.id) as Message;
    } catch (error: any) {
      // Update message status to failed
      await storage.updateMessage(message.id, {
        status: 'failed',
        metadata: { error: error?.message || 'Unknown error' },
      });

      // Log error
      await storage.createSystemLog({
        level: 'error',
        message: `Failed to send report to ${phoneNumber}: ${error?.message || 'Unknown error'}`,
        metadata: { messageId: message.id, sampleId, error: error?.message || 'Unknown error' },
      });

      throw error;
    }
  }

  async getMessageHistory(filters?: { status?: string; phoneNumber?: string; type?: string; limit?: number; offset?: number }): Promise<{ messages: Message[]; total: number }> {
    const messages = await storage.getMessages(filters);
    const total = await storage.getMessagesCount(filters);
    
    return { messages, total };
  }

  async getMessageStats(): Promise<MessageStats> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayMessages = await storage.getMessagesByDateRange(today, tomorrow);
    const totalMessages = await storage.getMessagesCount();
    const pendingMessages = await storage.getMessagesCount({ status: 'pending' });

    return {
      totalMessages,
      sentToday: todayMessages.filter(m => m.status === 'sent' || m.status === 'delivered').length,
      deliveredToday: todayMessages.filter(m => m.status === 'delivered').length,
      failedToday: todayMessages.filter(m => m.status === 'failed').length,
      pendingCount: pendingMessages,
    };
  }

  async updateMessageDeliveryStatus(whatsappId: string, status: 'delivered' | 'read' | 'failed'): Promise<void> {
    // Find message by WhatsApp ID in metadata
    const allMessages = await storage.getMessages();
    const message = allMessages.find(m => 
      m.metadata && 
      typeof m.metadata === 'object' && 
      'whatsappId' in m.metadata && 
      m.metadata.whatsappId === whatsappId
    );

    if (message) {
      await storage.updateMessage(message.id, {
        status: status === 'delivered' || status === 'read' ? 'delivered' : 'failed',
        deliveredAt: status === 'delivered' || status === 'read' ? new Date() : null,
      });

      // Log delivery update
      await storage.createSystemLog({
        level: 'info',
        message: `Message delivery status updated to ${status}`,
        metadata: { messageId: message.id, whatsappId, status },
      });
    }
  }

  async resendMessage(messageId: string): Promise<Message> {
    const message = await storage.getMessage(messageId);
    if (!message) {
      throw new Error('Message not found');
    }

    if (message.type === 'text') {
      return await this.sendTextMessage(message.phoneNumber, message.content);
    } else if (message.type === 'report' && message.fileUrl && message.fileName && message.fileSize && message.sampleId) {
      return await this.sendReportMessage(
        message.phoneNumber,
        message.fileUrl,
        message.fileName,
        message.fileSize,
        message.sampleId,
        message.content
      );
    } else {
      throw new Error('Cannot resend message: missing required data');
    }
  }
}

export const messageService = new MessageService();
