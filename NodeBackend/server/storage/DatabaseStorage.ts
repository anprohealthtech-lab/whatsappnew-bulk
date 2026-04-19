import { eq, desc, and, gte, lte, sql, or } from 'drizzle-orm';
import { db } from '../db';
import { users, messages, systemLogs, blockedNumbers, autoResponses, contacts, hrAdmins, hrChatbotConfigs, himsPatients } from '@shared/schema';
import type { User, InsertUser, Message, InsertMessage, SystemLog, InsertSystemLog, BlockedNumber, AutoResponse, Contact, HRAdmin, HRChatbotConfig, HIMSPatient } from '@shared/schema';
import type { IStorage, TenantFilter } from '../storage';

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
    const variants = this.getPhoneVariants(phoneNumber);
    console.log(`[DatabaseStorage] isLead: input=${phoneNumber}, variants=${JSON.stringify(variants)}`);

    // Try each variant
    for (const variant of variants) {
      const result = await db.select()
        .from(contacts)
        .where(and(
          eq(contacts.phoneNumber, variant),
          eq(contacts.isLead, 'true')
        ))
        .limit(1);

      if (result[0]) {
        console.log(`[DatabaseStorage] isLead: found with variant=${variant}`);
        return true;
      }
    }

    // Fuzzy match - last 10 digits comparison
    const cleaned = this.normalizeHRPhone(phoneNumber);
    if (cleaned.length >= 10) {
      const allLeads = await db.select()
        .from(contacts)
        .where(eq(contacts.isLead, 'true'));

      for (const lead of allLeads) {
        const storedCleaned = this.normalizeHRPhone(lead.phoneNumber);
        if (storedCleaned.slice(-10) === cleaned.slice(-10)) {
          console.log(`[DatabaseStorage] isLead: fuzzy match found (stored=${lead.phoneNumber}, input=${phoneNumber})`);
          return true;
        }
      }
    }

    console.log(`[DatabaseStorage] isLead: not found`);
    return false;
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
    const variants = this.getPhoneVariants(phoneNumber);
    console.log(`[DatabaseStorage] getContact: input=${phoneNumber}, variants=${JSON.stringify(variants)}`);

    // Try each variant
    for (const variant of variants) {
      const result = await db.select()
        .from(contacts)
        .where(eq(contacts.phoneNumber, variant))
        .limit(1);

      if (result[0]) {
        console.log(`[DatabaseStorage] getContact: found with variant=${variant} (chatbotActive=${result[0].chatbotActive})`);
        return result[0];
      }
    }

    // Fuzzy match - last 10 digits comparison
    const cleaned = this.normalizeHRPhone(phoneNumber);
    if (cleaned.length >= 10) {
      const allContacts = await db.select().from(contacts);
      for (const contact of allContacts) {
        const storedCleaned = this.normalizeHRPhone(contact.phoneNumber);
        if (storedCleaned.slice(-10) === cleaned.slice(-10)) {
          console.log(`[DatabaseStorage] getContact: fuzzy match found (stored=${contact.phoneNumber}, input=${phoneNumber})`);
          return contact;
        }
      }
    }

    console.log(`[DatabaseStorage] getContact: not found`);
    return undefined;
  }

  async updateContact(phoneNumber: string, updates: Partial<Contact>): Promise<Contact | undefined> {
    // Resolve the actual stored phone number using variant/fuzzy matching
    const existingContact = await this.getContact(phoneNumber);
    if (!existingContact) {
      console.log(`[DatabaseStorage] updateContact: contact not found for ${phoneNumber}`);
      return undefined;
    }

    const updateData: any = {
      ...updates,
      updatedAt: new Date(),
    };

    const result = await db.update(contacts)
      .set(updateData)
      .where(eq(contacts.phoneNumber, existingContact.phoneNumber))
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
  // ============================================================================
  // HR Admin methods
  // ============================================================================

  // Normalize phone for HR admin - preserves LID format
  private normalizeHRPhone(phone: string): string {
    // If already has @, extract the number part
    if (phone.includes('@')) {
      return phone.split('@')[0].replace(/\D/g, '');
    }
    return phone.replace(/\D/g, '');
  }

  // Generate possible phone formats for lookup (handles LID + regular)
  private getPhoneVariants(phone: string): string[] {
    const cleaned = this.normalizeHRPhone(phone);
    const variants: string[] = [cleaned];
    
    // If it's a LID (typically 15+ digits), also check with @lid suffix stored
    if (cleaned.length >= 15) {
      variants.push(`${cleaned}@lid`);
    }
    
    // If it's a regular number (10-12 digits), generate variants
    if (cleaned.length <= 12) {
      // With country code
      if (cleaned.length === 10) {
        variants.push(`91${cleaned}`);
        variants.push(`91${cleaned}@s.whatsapp.net`);
      }
      // Without country code
      if (cleaned.startsWith('91') && cleaned.length === 12) {
        variants.push(cleaned.substring(2));
      }
      variants.push(`${cleaned}@s.whatsapp.net`);
    }
    
    return [...new Set(variants)]; // Dedupe
  }

  async getHRAdmin(phoneNumber: string): Promise<HRAdmin | undefined> {
    const variants = this.getPhoneVariants(phoneNumber);
    console.log(`[DatabaseStorage] getHRAdmin: input=${phoneNumber}, variants=${JSON.stringify(variants)}`);
    
    // Try each variant
    for (const variant of variants) {
      const result = await db.select()
        .from(hrAdmins)
        .where(eq(hrAdmins.phoneNumber, variant))
        .limit(1);
      
      if (result[0]) {
        console.log(`[DatabaseStorage] getHRAdmin result: found with variant=${variant} (org=${result[0].organizationId})`);
        return result[0];
      }
    }
    
    // Also try fuzzy match - check if any stored phone ends with or contains our number
    const cleaned = this.normalizeHRPhone(phoneNumber);
    if (cleaned.length >= 10) {
      const allAdmins = await db.select().from(hrAdmins);
      for (const admin of allAdmins) {
        const storedCleaned = this.normalizeHRPhone(admin.phoneNumber);
        // Check if last 10 digits match (handles country code variations)
        if (storedCleaned.slice(-10) === cleaned.slice(-10) || 
            cleaned.slice(-10) === storedCleaned.slice(-10)) {
          console.log(`[DatabaseStorage] getHRAdmin result: fuzzy match found (stored=${admin.phoneNumber}, input=${phoneNumber})`);
          return admin;
        }
      }
    }
    
    console.log(`[DatabaseStorage] getHRAdmin result: not found`);
    return undefined;
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

  async getAllHRAdmins(): Promise<HRAdmin[]> {
    return await db.select().from(hrAdmins);
  }

  async getHRAdminsByOrganization(organizationId: string): Promise<HRAdmin[]> {
    return await db.select()
      .from(hrAdmins)
      .where(eq(hrAdmins.organizationId, organizationId));

  }

  async createHRAdmin(data: { 
    phoneNumber: string; 
    name?: string; 
    organizationId: string; 
    userId: string; 
    organizationName?: string 
  }): Promise<HRAdmin> {
    // Store phone as-is to preserve LID format
    // Only clean it (remove spaces/dashes) but keep the format indicator
    let phoneToStore = data.phoneNumber.replace(/[\s\-\(\)]/g, '');
    
    // If it doesn't have @, add appropriate suffix based on length
    if (!phoneToStore.includes('@')) {
      if (phoneToStore.length >= 15) {
        phoneToStore = `${phoneToStore}@lid`;
      } else {
        // Normalize regular phone
        const cleaned = phoneToStore.replace(/\D/g, '');
        phoneToStore = cleaned.length === 10 ? `91${cleaned}` : cleaned;
      }
    }
    
    console.log(`[DatabaseStorage] createHRAdmin: input=${data.phoneNumber}, storing=${phoneToStore}`);
    
    // Check if HR admin exists (using fuzzy lookup)
    const existing = await this.getHRAdmin(data.phoneNumber);

    if (existing) {
      // Update existing
      const result = await db.update(hrAdmins)
        .set({
          name: data.name || existing.name,
          organizationId: data.organizationId,
          userId: data.userId,
          organizationName: data.organizationName || existing.organizationName,
          chatbotActive: 'true',
          updatedAt: new Date(),
        })
        .where(eq(hrAdmins.id, existing.id))
        .returning();
      
      return result[0];
    } else {
      // Create new
      const result = await db.insert(hrAdmins)
        .values({
          phoneNumber: phoneToStore,
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
    // Use fuzzy lookup to find the admin
    const existing = await this.getHRAdmin(phoneNumber);
    if (!existing) {
      console.log(`[DatabaseStorage] updateHRAdmin: not found for ${phoneNumber}`);
      return undefined;
    }
    
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
      .where(eq(hrAdmins.id, existing.id))
      .returning();
    
    return result[0];
  }

  async deleteHRAdmin(phoneNumber: string): Promise<void> {
    // Use fuzzy lookup to find the admin
    const existing = await this.getHRAdmin(phoneNumber);
    if (existing) {
      await db.delete(hrAdmins).where(eq(hrAdmins.id, existing.id));
    }
  }

  async isHRAdmin(phoneNumber: string): Promise<boolean> {
    // Use the enhanced getHRAdmin which handles LID + regular formats
    const admin = await this.getHRAdmin(phoneNumber);
    return !!admin;
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

  // ============================================================================
  // HIMS Patient methods
  // ============================================================================

  async getHIMSPatient(phoneNumber: string): Promise<HIMSPatient | undefined> {
    const variants = this.getPhoneVariants(phoneNumber);
    console.log(`[DatabaseStorage] getHIMSPatient: input=${phoneNumber}, variants=${JSON.stringify(variants)}`);

    for (const variant of variants) {
      const result = await db.select()
        .from(himsPatients)
        .where(eq(himsPatients.phoneNumber, variant))
        .limit(1);

      if (result[0]) {
        console.log(`[DatabaseStorage] getHIMSPatient: found with variant=${variant} (org=${result[0].organizationId})`);
        return result[0];
      }
    }

    // Fuzzy match on last 10 digits
    const cleaned = this.normalizeHRPhone(phoneNumber);
    if (cleaned.length >= 10) {
      const all = await db.select().from(himsPatients);
      for (const p of all) {
        const storedCleaned = this.normalizeHRPhone(p.phoneNumber);
        if (storedCleaned.slice(-10) === cleaned.slice(-10) ||
            cleaned.slice(-10) === storedCleaned.slice(-10)) {
          console.log(`[DatabaseStorage] getHIMSPatient: fuzzy match (stored=${p.phoneNumber}, input=${phoneNumber})`);
          return p;
        }
      }
    }

    console.log(`[DatabaseStorage] getHIMSPatient: not found`);
    return undefined;
  }

  async getAllHIMSPatients(): Promise<HIMSPatient[]> {
    return await db.select().from(himsPatients);
  }

  async getHIMSPatientsByOrganization(organizationId: string): Promise<HIMSPatient[]> {
    return await db.select()
      .from(himsPatients)
      .where(eq(himsPatients.organizationId, organizationId));
  }

  async createHIMSPatient(data: {
    phoneNumber: string;
    name?: string;
    organizationId: string;
    systemPrompt?: string;
    triggerKeywords?: string[];
    greetingMessage?: string;
  }): Promise<HIMSPatient> {
    let phoneToStore = data.phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (!phoneToStore.includes('@')) {
      if (phoneToStore.length >= 15) {
        phoneToStore = `${phoneToStore}@lid`;
      } else {
        const cleaned = phoneToStore.replace(/\D/g, '');
        phoneToStore = cleaned.length === 10 ? `91${cleaned}` : cleaned;
      }
    }

    console.log(`[DatabaseStorage] createHIMSPatient: input=${data.phoneNumber}, storing=${phoneToStore}`);

    const existing = await this.getHIMSPatient(data.phoneNumber);

    if (existing) {
      const result = await db.update(himsPatients)
        .set({
          name: data.name || existing.name,
          organizationId: data.organizationId,
          systemPrompt: data.systemPrompt ?? existing.systemPrompt,
          triggerKeywords: data.triggerKeywords ?? existing.triggerKeywords,
          greetingMessage: data.greetingMessage ?? existing.greetingMessage,
          chatbotActive: 'true',
          updatedAt: new Date(),
        })
        .where(eq(himsPatients.id, existing.id))
        .returning();
      return result[0];
    } else {
      const result = await db.insert(himsPatients)
        .values({
          phoneNumber: phoneToStore,
          name: data.name || null,
          organizationId: data.organizationId,
          systemPrompt: data.systemPrompt || null,
          triggerKeywords: data.triggerKeywords || null,
          greetingMessage: data.greetingMessage || null,
          chatbotActive: 'true',
        })
        .returning();
      return result[0];
    }
  }

  async updateHIMSPatient(phoneNumber: string, updates: Partial<HIMSPatient>): Promise<HIMSPatient | undefined> {
    const existing = await this.getHIMSPatient(phoneNumber);
    if (!existing) {
      console.log(`[DatabaseStorage] updateHIMSPatient: not found for ${phoneNumber}`);
      return undefined;
    }

    const updateData: any = { ...updates, updatedAt: new Date() };
    if (typeof updates.chatbotActive === 'boolean') {
      updateData.chatbotActive = updates.chatbotActive ? 'true' : 'false';
    }

    const result = await db.update(himsPatients)
      .set(updateData)
      .where(eq(himsPatients.id, existing.id))
      .returning();
    return result[0];
  }

  async deleteHIMSPatient(phoneNumber: string): Promise<void> {
    const existing = await this.getHIMSPatient(phoneNumber);
    if (existing) {
      await db.delete(himsPatients).where(eq(himsPatients.id, existing.id));
    }
  }

  // ============================================================================
  // TENANT-AWARE METHODS (multi-user scoped)
  // ============================================================================

  async getMessagesByTenant(tenant: TenantFilter, filters?: {
    status?: string; phoneNumber?: string; type?: string; limit?: number; offset?: number;
  }): Promise<Message[]> {
    const conditions = [
      eq(messages.organizationId, tenant.organizationId),
      eq(messages.userId, tenant.userId),
    ];
    if (filters?.status) conditions.push(eq(messages.status, filters.status));
    if (filters?.phoneNumber) conditions.push(eq(messages.phoneNumber, filters.phoneNumber));
    if (filters?.type) conditions.push(eq(messages.type, filters.type));

    let query = db.select().from(messages).where(and(...conditions)).orderBy(desc(messages.createdAt));
    if (filters?.limit) query = query.limit(filters.limit) as any;
    if (filters?.offset) query = query.offset(filters.offset) as any;
    return await query;
  }

  async createMessageForTenant(tenant: TenantFilter, message: InsertMessage): Promise<Message> {
    const result = await db.insert(messages).values({
      ...message,
      organizationId: tenant.organizationId,
      userId: tenant.userId,
    }).returning();
    return result[0];
  }

  async getAutoResponsesByTenant(tenant: TenantFilter): Promise<AutoResponse[]> {
    return db.select().from(autoResponses).where(and(
      eq(autoResponses.organizationId, tenant.organizationId),
      eq(autoResponses.userId, tenant.userId),
      eq(autoResponses.isActive, 'true'),
    )).orderBy(desc(autoResponses.createdAt));
  }

  async createAutoResponseForTenant(tenant: TenantFilter, data: {
    keyword: string; response: string; isActive?: boolean;
  }): Promise<AutoResponse> {
    const result = await db.insert(autoResponses).values({
      keyword: data.keyword,
      response: data.response,
      isActive: data.isActive === false ? 'false' : 'true',
      organizationId: tenant.organizationId,
      userId: tenant.userId,
    }).returning();
    return result[0];
  }

  async getBlockedNumbersByTenant(tenant: TenantFilter): Promise<BlockedNumber[]> {
    return db.select().from(blockedNumbers).where(and(
      eq(blockedNumbers.organizationId, tenant.organizationId),
      eq(blockedNumbers.userId, tenant.userId),
    )).orderBy(desc(blockedNumbers.blockedAt));
  }

  async getBlockedNumberByTenant(tenant: TenantFilter, phoneNumber: string): Promise<BlockedNumber | undefined> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    const result = await db.select().from(blockedNumbers).where(and(
      eq(blockedNumbers.organizationId, tenant.organizationId),
      eq(blockedNumbers.userId, tenant.userId),
      eq(blockedNumbers.phoneNumber, cleanedNumber),
    )).limit(1);
    return result[0];
  }

  async addToBlocklistForTenant(tenant: TenantFilter, phoneNumber: string, reason = 'user_requested'): Promise<BlockedNumber> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    const result = await db.insert(blockedNumbers).values({
      phoneNumber: cleanedNumber,
      reason,
      organizationId: tenant.organizationId,
      userId: tenant.userId,
    }).returning();
    return result[0];
  }

  async isNumberBlockedForTenant(tenant: TenantFilter, phoneNumber: string): Promise<boolean> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    const result = await db.select().from(blockedNumbers).where(and(
      eq(blockedNumbers.organizationId, tenant.organizationId),
      eq(blockedNumbers.userId, tenant.userId),
      eq(blockedNumbers.phoneNumber, cleanedNumber),
    )).limit(1);
    return result.length > 0;
  }

  async removeFromBlocklistForTenant(tenant: TenantFilter, phoneNumber: string): Promise<void> {
    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    await db.delete(blockedNumbers).where(and(
      eq(blockedNumbers.organizationId, tenant.organizationId),
      eq(blockedNumbers.userId, tenant.userId),
      eq(blockedNumbers.phoneNumber, cleanedNumber),
    ));
  }

  async getAllAutoResponsesByTenant(tenant: TenantFilter): Promise<AutoResponse[]> {
    return db.select().from(autoResponses).where(and(
      eq(autoResponses.organizationId, tenant.organizationId),
      eq(autoResponses.userId, tenant.userId),
    )).orderBy(desc(autoResponses.createdAt));
  }

  async updateAutoResponseForTenant(
    tenant: TenantFilter,
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
      .where(and(
        eq(autoResponses.id, id),
        eq(autoResponses.organizationId, tenant.organizationId),
        eq(autoResponses.userId, tenant.userId),
      ))
      .returning();

    return result[0];
  }

  async deleteAutoResponseForTenant(tenant: TenantFilter, id: string): Promise<void> {
    await db.delete(autoResponses).where(and(
      eq(autoResponses.id, id),
      eq(autoResponses.organizationId, tenant.organizationId),
      eq(autoResponses.userId, tenant.userId),
    ));
  }

  async getContactsByTenant(tenant: TenantFilter, filters?: { limit?: number; offset?: number }): Promise<Contact[]> {
    let query = db.select().from(contacts).where(and(
      eq(contacts.organizationId, tenant.organizationId),
      eq(contacts.userId, tenant.userId),
    )).orderBy(desc(contacts.lastMessageAt));
    if (filters?.limit) query = query.limit(filters.limit) as any;
    if (filters?.offset) query = query.offset(filters.offset) as any;
    return await query;
  }

  async getLeadsByTenant(tenant: TenantFilter, filters?: { limit?: number; offset?: number }): Promise<Contact[]> {
    let query = db.select().from(contacts).where(and(
      eq(contacts.organizationId, tenant.organizationId),
      eq(contacts.userId, tenant.userId),
      eq(contacts.isLead, 'true'),
    )).orderBy(desc(contacts.lastMessageAt));
    if (filters?.limit) query = query.limit(filters.limit) as any;
    if (filters?.offset) query = query.offset(filters.offset) as any;
    return await query;
  }

  async flagAsLeadForTenant(tenant: TenantFilter, phoneNumber: string, keyword: string, name?: string): Promise<Contact> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    const existing = await db.select().from(contacts)
      .where(and(
        eq(contacts.organizationId, tenant.organizationId),
        eq(contacts.userId, tenant.userId),
        eq(contacts.phoneNumber, normalizedPhone),
      )).limit(1);

    if (existing.length > 0) {
      const result = await db.update(contacts).set({
        isLead: 'true',
        leadTriggerKeyword: keyword,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
        ...(name && { name }),
      }).where(eq(contacts.id, existing[0].id)).returning();
      return result[0];
    } else {
      const result = await db.insert(contacts).values({
        phoneNumber: normalizedPhone,
        name: name || null,
        isLead: 'true',
        leadTriggerKeyword: keyword,
        lastMessageAt: new Date(),
        organizationId: tenant.organizationId,
        userId: tenant.userId,
      }).returning();
      return result[0];
    }
  }

  async isLeadForTenant(tenant: TenantFilter, phoneNumber: string): Promise<boolean> {
    const contact = await this.getContactByTenant(tenant, phoneNumber);
    return contact?.isLead === 'true';
  }

  async getContactByTenant(tenant: TenantFilter, phoneNumber: string): Promise<Contact | undefined> {
    const variants = this.getPhoneVariants(phoneNumber);
    for (const variant of variants) {
      const result = await db.select().from(contacts)
        .where(and(
          eq(contacts.organizationId, tenant.organizationId),
          eq(contacts.userId, tenant.userId),
          eq(contacts.phoneNumber, variant),
        )).limit(1);
      if (result[0]) return result[0];
    }
    // Fuzzy match scoped to tenant
    const cleaned = this.normalizeHRPhone(phoneNumber);
    if (cleaned.length >= 10) {
      const tenantContacts = await db.select().from(contacts).where(and(
        eq(contacts.organizationId, tenant.organizationId),
        eq(contacts.userId, tenant.userId),
      ));
      for (const contact of tenantContacts) {
        const storedCleaned = this.normalizeHRPhone(contact.phoneNumber);
        if (storedCleaned.slice(-10) === cleaned.slice(-10)) return contact;
      }
    }
    return undefined;
  }

  async updateContactByTenant(tenant: TenantFilter, phoneNumber: string, updates: Partial<Contact>): Promise<Contact | undefined> {
    const existing = await this.getContactByTenant(tenant, phoneNumber);
    if (!existing) return undefined;
    const result = await db.update(contacts).set({
      ...updates,
      updatedAt: new Date(),
    }).where(eq(contacts.id, existing.id)).returning();
    return result[0];
  }

  async getConversationHistoryByTenant(tenant: TenantFilter, phoneNumber: string, limit: number = 10): Promise<Message[]> {
    return await db.select().from(messages)
      .where(and(
        eq(messages.organizationId, tenant.organizationId),
        eq(messages.userId, tenant.userId),
        eq(messages.phoneNumber, phoneNumber),
        or(eq(messages.type, 'incoming'), eq(messages.type, 'text'))
      ))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
  }
}
