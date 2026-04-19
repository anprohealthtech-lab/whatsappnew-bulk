-- Add enabled_features JSONB column to users table
-- Controls which features are activated per user (Task Management, HIMS Chatbot)
ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_features JSONB DEFAULT '{"taskManagement": false, "himsChatbot": false}'::jsonb;
