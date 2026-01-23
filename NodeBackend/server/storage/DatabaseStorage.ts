import { eq, desc, and, gte, lte, sql, or } from 'drizzle-orm';
import { db } from '../db';
import { users, messages, systemLogs, blockedNumbers, autoResponses, contacts, chatbotConfigs, hrAdmins, hrChatbotConfigs } from '@shared/schema';
import type { User, InsertUser, Message, InsertMessage, SystemLog, InsertSystemLog, BlockedNumber, AutoResponse, Contact, ChatbotConfig, HRAdmin, HRChatbotConfig } from '@shared/schema';
import type { IStorage } from '../storage';

export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  // Message methods
  async getMessage(id: string): Promise<Message | undefined> {
    const result = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return result[0];
  }

  async getMessages(filters?: { 
    status?: string; 
    phoneNumber?: string; 
    type?: string; 
    limit?: number; 
    offset?: number 
  }): Promise<Message[]> {
    let query = db.select().from(messages);

    const conditions = [];
    if (filters?.status) conditions.push(eq(messages.status, filters.status));
    if (filters?.phoneNumber) conditions.push(eq(messages.phoneNumber, filters.phoneNumber));
    if (filters?.type) conditions.push(eq(messages.type, filters.type));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    query = query.orderBy(desc(messages.createdAt)) as any;

    if (filters?.limit) {
      query = query.limit(filters.limit) as any;
    }
    if (filters?.offset) {
      query = query.offset(filters.offset) as any;
    }

    return await query;
  }

  async createMessage(message: InsertMessage): Promise<Message> {
    const result = await db.insert(messages).values(message).returning();
    return result[0];
  }

  async updateMessage(id: string, updates: Partial<Message>): Promise<Message | undefined> {
    const result = await db.update(messages)
      .set(updates)
      .where(eq(messages.id, id))
      .returning();
    return result[0];
  }

  async getMessagesCount(filters?: { 
    status?: string; 
    phoneNumber?: string; 
    type?: string 
  }): Promise<number> {
    let query = db.select({ count: sql<number>`count(*)` }).from(messages);

    const conditions = [];
    if (filters?.status) conditions.push(eq(messages.status, filters.status));
    if (filters?.phoneNumber) conditions.push(eq(messages.phoneNumber, filters.phoneNumber));
    if (filters?.type) conditions.push(eq(messages.type, filters.type));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const result = await query;
    return result[0]?.count || 0;
  }

  async getMessagesByDateRange(startDate: Date, endDate: Date): Promise<Message[]> {
    return await db.select().from(messages)
      .where(and(
        gte(messages.createdAt, startDate),
        lte(messages.createdAt, endDate)
      ) as any)
      .orderBy(desc(messages.createdAt)) as any;
  }

  // System log methods
  async getSystemLogs(limit: number = 50, offset: number = 0): Promise<SystemLog[]> {
    return await db.select().from(systemLogs)
      .orderBy(desc(systemLogs.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async createSystemLog(log: InsertSystemLog): Promise<SystemLog> {
    const result = await db.insert(systemLogs).values(log).returning();
    return result[0];
  }

  // Blocklist methods
  async addToBlocklist(phoneNumber: string, reason: string = 'user_requested'): Promise<BlockedNumber> {
    // Clean phone number format
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    
    const result = await db.insert(blockedNumbers)
      .values({
        phoneNumber: cleanedNumber,
        reason
      })
      .onConflictDoNothing()
      .returning();
    
    return result[0] || await this.getBlockedNumber(cleanedNumber);
  }

  async removeFromBlocklist(phoneNumber: string): Promise<void> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    await db.delete(blockedNumbers).where(eq(blockedNumbers.phoneNumber, cleanedNumber));
  }

  async isNumberBlocked(phoneNumber: string): Promise<boolean> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    const result = await db.select()
      .from(blockedNumbers)
      .where(eq(blockedNumbers.phoneNumber, cleanedNumber))
      .limit(1);
    
    return result.length > 0;
  }

  async getBlockedNumbers(): Promise<BlockedNumber[]> {
    return await db.select()
      .from(blockedNumbers)
      .orderBy(desc(blockedNumbers.blockedAt));
  }

  async getBlockedNumber(phoneNumber: string): Promise<BlockedNumber | undefined> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    const result = await db.select()
      .from(blockedNumbers)
      .where(eq(blockedNumbers.phoneNumber, cleanedNumber))
      .limit(1);
    
    return result[0];
  }

  // Auto-response methods
  async getAutoResponses(): Promise<AutoResponse[]> {
    return await db.select()
      .from(autoResponses)
      .where(eq(autoResponses.isActive, 'true'))
      .orderBy(desc(autoResponses.createdAt));
  }

  async getAllAutoResponses(): Promise<AutoResponse[]> {
    return await db.select()
      .from(autoResponses)
      .orderBy(desc(autoResponses.createdAt));
  }

  async createAutoResponse(data: {
    keyword: string;
    response: string;
    isActive?: boolean;
  }): Promise<AutoResponse> {
    const result = await db.insert(autoResponses)
      .values({
        keyword: data.keyword,
        response: data.response,
        isActive: data.isActive === false ? 'false' : 'true',
      })
      .returning();
    
    return result[0];
  }

  async updateAutoResponse(
    id: string,
    data: { keyword?: string; response?: string; isActive?: boolean }
  ): Promise<AutoResponse | undefined> {
    const updateData: any = {
      updatedAt: new Date(),
    };
    
    if (data.keyword !== undefined) updateData.keyword = data.keyword;
    if (data.response !== undefined) updateData.response = data.response;
    if (data.isActive !== undefined) updateData.isActive = data.isActive ? 'true' : 'false';

    const result = await db.update(autoResponses)
      .set(updateData)
      .where(eq(autoResponses.id, id))
      .returning();
    
    return result[0];
  }

  async deleteAutoResponse(id: string): Promise<void> {
    await db.delete(autoResponses).where(eq(autoResponses.id, id));
  }

  // Contact/Lead methods
  private normalizePhoneNumber(phone: string): string {
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');
    
    // If it's a 10-digit Indian number, add '91'
    if (cleaned.length === 10) {
      return '91' + cleaned;
    }
    
    return cleaned;
  }

  async flagAsLead(phoneNumber: string, keyword: string, name?: string): Promise<Contact> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    
    // Check if contact exists
    const existing = await db.select()
      .from(contacts)
      .where(eq(contacts.phoneNumber, normalizedPhone))
      .limit(1);

    if (existing.length > 0) {
      // Update existing contact
      const result = await db.update(contacts)
        .set({
          isLead: 'true',
          leadTriggerKeyword: keyword,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          ...(name && { name }),
        })
        .where(eq(contacts.phoneNumber, normalizedPhone))
        .returning();
      
      return result[0];
    } else {
      // Create new contact
      const result = await db.insert(contacts)
        .values({
          phoneNumber: normalizedPhone,
          name: name || null,
          isLead: 'true',
          leadTriggerKeyword: keyword,
          lastMessageAt: new Date(),
        })
        .returning();
      
      return result[0];
    }
  }

  async isLead(phoneNumber: string): Promise<boolean> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    
    const result = await db.select()
      .from(contacts)
      .where(and(
        eq(contacts.phoneNumber, normalizedPhone),
        eq(contacts.isLead, 'true')
      ))
      .limit(1);
    
    return result.length > 0;
  }

  async getLeads(filters?: { limit?: number; offset?: number }): Promise<Contact[]> {
    let query = db.select()
      .from(contacts)
      .where(eq(contacts.isLead, 'true'))
      .orderBy(desc(contacts.lastMessageAt));

    if (filters?.limit) {
      query = query.limit(filters.limit) as any;
    }
    
    if (filters?.offset) {
      query = query.offset(filters.offset) as any;
    }

    return await query;
  }

  async getContact(phoneNumber: string): Promise<Contact | undefined> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    console.log(`[DatabaseStorage] getContact: input=${phoneNumber}, normalized=${normalizedPhone}`);
    
    const result = await db.select()
      .from(contacts)
      .where(eq(contacts.phoneNumber, normalizedPhone))
      .limit(1);
    
    console.log(`[DatabaseStorage] getContact result: ${result[0] ? `found (chatbotActive=${result[0].chatbotActive})` : 'not found'}`);
    return result[0];
  }

  async updateContact(phoneNumber: string, updates: Partial<Contact>): Promise<Contact | undefined> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    
    const updateData: any = {
      ...updates,
      updatedAt: new Date(),
    };

    const result = await db.update(contacts)
      .set(updateData)
      .where(eq(contacts.phoneNumber, normalizedPhone))
      .returning();
    
    return result[0];
  }

  async getConversationHistory(phoneNumber: string, limit: number = 10): Promise<Message[]> {
    // Don't normalize - messages are stored with full JID (@lid or @s.whatsapp.net)
    // Just use the phoneNumber as-is to match what was saved
    const result = await db.select()
      .from(messages)
      .where(and(
        eq(messages.phoneNumber, phoneNumber),
        or(
          eq(messages.type, 'incoming'),
          eq(messages.type, 'text')
        )
      ))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    
    return result;
  }

  // Chatbot config methods
  async getChatbotConfig(): Promise<ChatbotConfig | undefined> {
    const result = await db.select()
      .from(chatbotConfigs)
      .orderBy(desc(chatbotConfigs.updatedAt))
      .limit(1);
    
    return result[0];
  }

  async updateChatbotConfig(config: Partial<ChatbotConfig> & { agentName: string }): Promise<ChatbotConfig> {
    // Check if config exists
    const existing = await this.getChatbotConfig();

    if (existing) {
      // Update existing config
      const updateData: any = {
        ...config,
        isActive: typeof config.isActive === 'boolean' ? (config.isActive ? 'true' : 'false') : existing.isActive,
        updatedAt: new Date(),
      };

      const result = await db.update(chatbotConfigs)
        .set(updateData)
        .where(eq(chatbotConfigs.id, existing.id))
        .returning();
      
      return result[0];
    } else {
      // Create new config
      const result = await db.insert(chatbotConfigs)
        .values({
          agentName: config.agentName,
          triggerKeywords: config.triggerKeywords || [],
          ragBaseUrl: config.ragBaseUrl || '',
          ragAccessKey: config.ragAccessKey || '',
          contextMessageCount: config.contextMessageCount || 3,
          isActive: typeof config.isActive === 'boolean' ? (config.isActive ? 'true' : 'false') : 'true',
        })
        .returning();
      
      return result[0];
    }
  }

  // ============================================================================
  // HR Admin methods
  // ============================================================================

  async getHRAdmin(phoneNumber: string): Promise<HRAdmin | undefined> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    console.log(`[DatabaseStorage] getHRAdmin: input=${phoneNumber}, normalized=${normalizedPhone}`);
    
    const result = await db.select()
      .from(hrAdmins)
      .where(eq(hrAdmins.phoneNumber, normalizedPhone))
      .limit(1);
    
    console.log(`[DatabaseStorage] getHRAdmin result: ${result[0] ? `found (org=${result[0].organizationId})` : 'not found'}`);
    return result[0];
  }

  async getHRAdmins(filters?: { limit?: number; offset?: number }): Promise<HRAdmin[]> {
    let query = db.select()
      .from(hrAdmins)
      .orderBy(desc(hrAdmins.updatedAt));

    if (filters?.limit) {
      query = query.limit(filters.limit) as any;
    }
    
    if (filters?.offset) {
      query = query.offset(filters.offset) as any;
    }

    return await query;
  }

  async createHRAdmin(data: { 
    phoneNumber: string; 
    name?: string; 
    organizationId: string; 
    userId: string; 
    organizationName?: string 
  }): Promise<HRAdmin> {
    const normalizedPhone = this.normalizePhoneNumber(data.phoneNumber);
    
    // Check if HR admin exists
    const existing = await db.select()
      .from(hrAdmins)
      .where(eq(hrAdmins.phoneNumber, normalizedPhone))
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      const result = await db.update(hrAdmins)
        .set({
          name: data.name || existing[0].name,
          organizationId: data.organizationId,
          userId: data.userId,
          organizationName: data.organizationName || existing[0].organizationName,
          chatbotActive: 'true',
          updatedAt: new Date(),
        })
        .where(eq(hrAdmins.phoneNumber, normalizedPhone))
        .returning();
      
      return result[0];
    } else {
      // Create new
      const result = await db.insert(hrAdmins)
        .values({
          phoneNumber: normalizedPhone,
          name: data.name || null,
          organizationId: data.organizationId,
          userId: data.userId,
          organizationName: data.organizationName || null,
          chatbotActive: 'true',
        })
        .returning();
      
      return result[0];
    }
  }

  async updateHRAdmin(phoneNumber: string, updates: Partial<HRAdmin>): Promise<HRAdmin | undefined> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    
    const updateData: any = {
      ...updates,
      updatedAt: new Date(),
    };

    // Handle boolean to string conversion for chatbotActive
    if (typeof updates.chatbotActive === 'boolean') {
      updateData.chatbotActive = updates.chatbotActive ? 'true' : 'false';
    }

    const result = await db.update(hrAdmins)
      .set(updateData)
      .where(eq(hrAdmins.phoneNumber, normalizedPhone))
      .returning();
    
    return result[0];
  }

  async deleteHRAdmin(phoneNumber: string): Promise<void> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    await db.delete(hrAdmins).where(eq(hrAdmins.phoneNumber, normalizedPhone));
  }

  async isHRAdmin(phoneNumber: string): Promise<boolean> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    
    const result = await db.select()
      .from(hrAdmins)
      .where(eq(hrAdmins.phoneNumber, normalizedPhone))
      .limit(1);
    
    return result.length > 0;
  }

  // ============================================================================
  // HR Chatbot Config methods
  // ============================================================================

  async getHRChatbotConfig(): Promise<HRChatbotConfig | undefined> {
    const result = await db.select()
      .from(hrChatbotConfigs)
      .orderBy(desc(hrChatbotConfigs.updatedAt))
      .limit(1);
    
    return result[0];
  }

  async updateHRChatbotConfig(config: Partial<HRChatbotConfig> & { agentName: string }): Promise<HRChatbotConfig> {
    // Check if config exists
    const existing = await this.getHRChatbotConfig();

    if (existing) {
      // Update existing config
      const updateData: any = {
        ...config,
        isActive: typeof config.isActive === 'boolean' ? (config.isActive ? 'true' : 'false') : existing.isActive,
        updatedAt: new Date(),
      };

      const result = await db.update(hrChatbotConfigs)
        .set(updateData)
        .where(eq(hrChatbotConfigs.id, existing.id))
        .returning();
      
      return result[0];
    } else {
      // Create new config
      const result = await db.insert(hrChatbotConfigs)
        .values({
          agentName: config.agentName,
          ragBaseUrl: config.ragBaseUrl || '',
          ragAccessKey: config.ragAccessKey || '',
          supabaseUrl: config.supabaseUrl || '',
          supabaseServiceKey: config.supabaseServiceKey || '',
          contextMessageCount: config.contextMessageCount || 5,
          isActive: typeof config.isActive === 'boolean' ? (config.isActive ? 'true' : 'false') : 'true',
        })
        .returning();
      
      return result[0];
    }
  }
}
