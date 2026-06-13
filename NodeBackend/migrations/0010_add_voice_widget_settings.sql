ALTER TABLE voice_agents
ADD COLUMN IF NOT EXISTS widget_settings jsonb
DEFAULT '{"title":"Ask our AI assistant","welcomeMessage":"Tap the microphone and ask a question.","accentColor":"#6d5dfc","avatarUrl":null,"starterText":"Hello! Ask me anything and I will do my best to help.","starterAudioUrl":null,"starterAudioMimeType":null}'::jsonb;
