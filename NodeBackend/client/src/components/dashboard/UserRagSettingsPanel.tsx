import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/AuthContext";
import {
  Bot,
  Save,
  Loader2,
  TestTube2,
  CheckCircle,
  AlertCircle,
  Database,
  MessageSquare,
  Clock,
  Hash,
  X,
  Zap,
  CalendarClock,
  Copy,
  Trash2,
  RefreshCw,
  Eye,
  EyeOff,
  Plus,
  GitBranch,
} from "lucide-react";

interface RagConfig {
  id?: string;
  agentName: string;
  ragBaseUrl: string;
  ragAccessKey: string;
  systemPrompt?: string;
  isActive: string;
  triggerKeywords?: string[];
  greetingMessage?: string;
  contextMessageCount?: number;
  replyCooldownSeconds?: number;
  typingDelayMs?: number;
  intakeMode?: string;
  followupsEnabled?: string;
  autoSequenceEnabled?: string;
  sequenceTemplate?: Array<{ delay: string; message: string }>;
}

export function UserRagSettingsPanel() {
  const [agentName, setAgentName] = useState("");
  const [ragBaseUrl, setRagBaseUrl] = useState("");
  const [ragAccessKey, setRagAccessKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [useBuiltInRag, setUseBuiltInRag] = useState(false);
  const [triggerKeywords, setTriggerKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState("");
  const [greetingMessage, setGreetingMessage] = useState("");
  const [contextMessageCount, setContextMessageCount] = useState<number | "">(5);
  const [replyCooldownSeconds, setReplyCooldownSeconds] = useState<number | "">(10);
  const [typingDelayMs, setTypingDelayMs] = useState<number | "">(2000);
  const [intakeMode, setIntakeMode] = useState(false);
  const [followupsEnabled, setFollowupsEnabled] = useState(false);
  const [autoSequenceEnabled, setAutoSequenceEnabled] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Lead automation (intake mode + follow-ups) is a super-admin-gated capability.
  const features = (user?.enabledFeatures as any) || {};
  const leadAutomationAllowed = user?.role === "super_admin" || features.leadAutomation === true;

  const { data: config, isLoading } = useQuery<RagConfig | null>({
    queryKey: ["/api/user-rag-agent"],
    select: (data: any) => data?.data || null,
  });

  const { data: followups } = useQuery<any[]>({
    queryKey: ["/api/lead-followups"],
    select: (data: any) => data?.data || [],
    enabled: leadAutomationAllowed,
    refetchInterval: 30000,
  });

  const cancelFollowupMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/lead-followups/${id}/cancel`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Follow-up cancelled" });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-followups"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const pendingFollowups = (followups || []).filter((f) => f.status === "scheduled");

  const { data: pipelines } = useQuery<any[]>({
    queryKey: ["/api/lead-pipelines"],
    select: (data: any) => data?.data || [],
    enabled: leadAutomationAllowed,
  });

  const createPipelineMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/lead-pipelines", { name });
      return res.json();
    },
    onSuccess: () => {
      setNewPipelineName("");
      toast({ title: "Pipeline created" });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-pipelines"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deletePipelineMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/lead-pipelines/${id}`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Pipeline deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-pipelines"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const rotateTokenMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/lead-pipelines/${id}/rotate-token`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Token rotated", description: "Update your Apps Script with the new token." });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-pipelines"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const saveDripMutation = useMutation({
    mutationFn: async ({ id, dripEnabled, dripPrompt }: { id: string; dripEnabled: boolean; dripPrompt: string }) => {
      const res = await apiRequest("PATCH", `/api/lead-pipelines/${id}`, { dripEnabled, dripPrompt });
      return res.json();
    },
    onSuccess: (data: any) => {
      const count = Array.isArray(data?.data?.dripTemplate) ? data.data.dripTemplate.length : 0;
      toast({ title: "Drip saved", description: data?.data?.dripEnabled === "true" ? `${count} message(s) generated` : "Drip disabled" });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-pipelines"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const saveTemplateMutation = useMutation({
    mutationFn: async ({ id, dripTemplate }: { id: string; dripTemplate: Array<{ delay: string; message: string }> }) => {
      const res = await apiRequest("PATCH", `/api/lead-pipelines/${id}`, { dripTemplate });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Messages saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-pipelines"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const webhookUrl = `${window.location.origin}/api/ingest/lead`;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: `${label} copied` }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const appsScriptFor = (token: string) =>
    `const WEBHOOK_URL = '${webhookUrl}';\n` +
    `const INGEST_TOKEN = '${token}';\n` +
    `const SYNCED_HEADER = 'Synced At';\n\n` +
    `function syncAllLeads(){ Logger.log(pushLeads_(readSheet_().rows.map(r=>r.data))); }\n` +
    `function syncNewLeads(){\n` +
    `  const s=readSheet_(); const p=s.rows.filter(r=>!r.synced);\n` +
    `  if(!p.length){Logger.log('Nothing new');return;}\n` +
    `  Logger.log(pushLeads_(p.map(r=>r.data)));\n` +
    `  if(s.syncedCol>0){const t=new Date();p.forEach(r=>s.sheet.getRange(r.rowIndex,s.syncedCol).setValue(t));}\n` +
    `}\n` +
    `function readSheet_(){\n` +
    `  const sheet=SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();\n` +
    `  const v=sheet.getDataRange().getValues(); if(v.length<2)return{sheet,rows:[],syncedCol:0};\n` +
    `  const h=v[0].map(x=>String(x).trim()); let sc=0;\n` +
    `  if(SYNCED_HEADER){const i=h.indexOf(SYNCED_HEADER); if(i===-1){sc=h.length+1;sheet.getRange(1,sc).setValue(SYNCED_HEADER);h.push(SYNCED_HEADER);}else sc=i+1;}\n` +
    `  const rows=[]; for(let i=1;i<v.length;i++){const d={};h.forEach((k,c)=>{if(k&&k!==SYNCED_HEADER)d[k]=v[i][c];});rows.push({rowIndex:i+1,data:d,synced:sc>0?!!v[i][sc-1]:false});}\n` +
    `  return{sheet,rows,syncedCol:sc};\n` +
    `}\n` +
    `function pushLeads_(leads){\n` +
    `  const valid=leads.filter(l=>l&&(l.phone||l.mobile||l.phoneNumber)); if(!valid.length)return'No phone rows';\n` +
    `  const res=UrlFetchApp.fetch(WEBHOOK_URL,{method:'post',contentType:'application/json',headers:{'x-ingest-token':INGEST_TOKEN},payload:JSON.stringify({leads:valid}),muteHttpExceptions:true});\n` +
    `  return res.getResponseCode()+': '+res.getContentText();\n` +
    `}`;

  // Sync form with loaded config
  useEffect(() => {
    if (config) {
      setAgentName(config.agentName || "");
      const isBuiltIn = config.ragBaseUrl === "supabase-knowledge-base";
      setUseBuiltInRag(isBuiltIn);
      setRagBaseUrl(isBuiltIn ? "" : (config.ragBaseUrl || ""));
      setRagAccessKey(config.ragAccessKey || "");
      setSystemPrompt(config.systemPrompt || "");
      setIsActive(config.isActive !== "false");
      setTriggerKeywords(config.triggerKeywords || []);
      setGreetingMessage(config.greetingMessage || "");
      setContextMessageCount(config.contextMessageCount ?? 5);
      setReplyCooldownSeconds(config.replyCooldownSeconds ?? 10);
      setTypingDelayMs(config.typingDelayMs ?? 2000);
      setIntakeMode(config.intakeMode === "true");
      setFollowupsEnabled(config.followupsEnabled === "true");
      setAutoSequenceEnabled(config.autoSequenceEnabled === "true");
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        agentName: agentName || "Knowledge Base Bot",
        ragBaseUrl: useBuiltInRag ? "supabase-knowledge-base" : ragBaseUrl,
        isActive,
      };
      // For built-in RAG, set a placeholder key
      if (useBuiltInRag) {
        body.ragAccessKey = "built-in";
      } else if (ragAccessKey && !ragAccessKey.includes("****")) {
        body.ragAccessKey = ragAccessKey;
      } else if (config?.ragAccessKey) {
        body.ragAccessKey = "KEEP_EXISTING";
      } else {
        body.ragAccessKey = ragAccessKey;
      }
      if (systemPrompt) body.systemPrompt = systemPrompt;
      if (triggerKeywords.length > 0) body.triggerKeywords = triggerKeywords;
      if (greetingMessage) body.greetingMessage = greetingMessage;
      if (contextMessageCount !== "") body.contextMessageCount = contextMessageCount;
      if (replyCooldownSeconds !== "") body.replyCooldownSeconds = replyCooldownSeconds;
      if (typingDelayMs !== "") body.typingDelayMs = typingDelayMs;
      body.intakeMode = intakeMode;
      body.followupsEnabled = followupsEnabled;
      body.autoSequenceEnabled = autoSequenceEnabled;

      const res = await apiRequest("POST", "/api/user-rag-agent", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "RAG Config Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/user-rag-agent"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/chatbot/test", {});
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: "Connection Successful", description: "RAG endpoint is reachable." });
      } else {
        toast({ title: "Connection Failed", description: data.message || "Could not reach endpoint", variant: "destructive" });
      }
    },
    onError: (err: any) => toast({ title: "Test Failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            AI Chatbot / RAG Agent Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Active</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {leadAutomationAllowed && (
            <>
              <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
                <div>
                  <Label className="cursor-pointer flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-500" /> Intake Mode
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Engage <span className="font-medium">any</span> new number that messages — ask what they
                    want and answer via RAG, instead of only responding to trigger keywords.
                  </p>
                </div>
                <Switch checked={intakeMode} onCheckedChange={setIntakeMode} />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
                <div>
                  <Label className="cursor-pointer flex items-center gap-1.5">
                    <CalendarClock className="w-3.5 h-3.5 text-amber-500" /> Allow Follow-ups
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Let the bot schedule one timed follow-up nudge to a lead when it makes sense
                    (e.g. "checking in 2 days later"). Sent automatically at the chosen time.
                  </p>
                </div>
                <Switch checked={followupsEnabled} onCheckedChange={setFollowupsEnabled} />
              </div>

              <div className="p-3 border rounded-lg bg-muted/50 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="cursor-pointer flex items-center gap-1.5">
                      <GitBranch className="w-3.5 h-3.5 text-amber-500" /> Auto-create sequence on new lead
                      {autoSequenceEnabled && (config?.sequenceTemplate?.length ?? 0) > 0 && (
                        <span className="text-xs font-normal text-muted-foreground">({config?.sequenceTemplate?.length} msg)</span>
                      )}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      The bot reads your System Prompt as a workflow (e.g. "day 1 send this, day 2 that")
                      and, on each new lead, schedules that message sequence automatically. A lead's reply
                      stops the rest. Uses <span className="font-mono">{"{{name}}"}</span> for personalisation.
                      Generated when you Save.
                    </p>
                  </div>
                  <Switch checked={autoSequenceEnabled} onCheckedChange={setAutoSequenceEnabled} />
                </div>
                {autoSequenceEnabled && (config?.sequenceTemplate?.length ?? 0) > 0 && (
                  <div className="space-y-1 pt-1">
                    {config!.sequenceTemplate!.map((m, i) => (
                      <div key={i} className="text-xs flex gap-2">
                        <span className="text-amber-600 dark:text-amber-400 font-mono shrink-0">+{m.delay}</span>
                        <span className="text-muted-foreground line-clamp-2">{m.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <div>
            <Label>Agent Name</Label>
            <Input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g., Sales Bot"
            />
          </div>

          {/* Toggle between built-in and external RAG */}
          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-primary" />
              <div>
                <Label className="cursor-pointer">Use Built-in Knowledge Base</Label>
                <p className="text-xs text-muted-foreground">
                  Uses your uploaded files (Knowledge Base tab) instead of an external AI agent.
                </p>
              </div>
            </div>
            <Switch checked={useBuiltInRag} onCheckedChange={setUseBuiltInRag} />
          </div>

          {!useBuiltInRag && (
            <>
              <div>
                <Label>RAG Base URL</Label>
                <Input
                  value={ragBaseUrl}
                  onChange={(e) => setRagBaseUrl(e.target.value)}
                  placeholder="https://your-agent.digitalocean.app"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The base URL of your DigitalOcean AI Agent or compatible endpoint.
                </p>
              </div>

              <div>
                <Label>RAG Access Key</Label>
                <Input
                  type="password"
                  value={ragAccessKey}
                  onChange={(e) => setRagAccessKey(e.target.value)}
                  placeholder={config?.ragAccessKey ? "••••••••" : "Enter access key"}
                />
              </div>
            </>
          )}

          <div>
            <Label>Custom System Prompt (optional)</Label>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Override the default system prompt for your chatbot..."
              rows={5}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty to use the default system prompt.
            </p>
          </div>

          {/* Lead Chatbot Behaviour Section */}
          <div className="border-t pt-4 mt-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-primary" />
              Lead Chatbot Behaviour
            </h3>

            {/* Trigger Keywords */}
            <div className="mb-3">
              <Label>Trigger Keywords</Label>
              <p className="text-xs text-muted-foreground mb-1">
                Words that mark a contact as a lead. Leave empty to use global keywords.
              </p>
              <div className="flex flex-wrap gap-1 mb-1">
                {triggerKeywords.map((kw, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs">
                    {kw}
                    <X className="w-3 h-3 cursor-pointer" onClick={() => setTriggerKeywords(triggerKeywords.filter((_, j) => j !== i))} />
                  </span>
                ))}
              </div>
              <div className="flex gap-1">
                <Input
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === ",") && keywordInput.trim()) {
                      e.preventDefault();
                      setTriggerKeywords([...triggerKeywords, keywordInput.trim()]);
                      setKeywordInput("");
                    }
                  }}
                  placeholder="Type keyword, press Enter"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!keywordInput.trim()}
                  onClick={() => {
                    setTriggerKeywords([...triggerKeywords, keywordInput.trim()]);
                    setKeywordInput("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>

            {/* Greeting Message */}
            <div className="mb-3">
              <Label>Greeting Message</Label>
              <Textarea
                value={greetingMessage}
                onChange={(e) => setGreetingMessage(e.target.value)}
                placeholder="e.g., Hi! Thanks for reaching out. How can I help you today?"
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Sent when a new lead is first detected. Leave empty for global greeting.
              </p>
            </div>

            {/* Numeric Config Row */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="flex items-center gap-1">
                  <Hash className="w-3 h-3" /> Context Messages
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={contextMessageCount}
                  onChange={(e) => setContextMessageCount(e.target.value ? Number(e.target.value) : "")}
                />
                <p className="text-xs text-muted-foreground mt-0.5">History sent to RAG</p>
              </div>
              <div>
                <Label className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Cooldown (s)
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={replyCooldownSeconds}
                  onChange={(e) => setReplyCooldownSeconds(e.target.value ? Number(e.target.value) : "")}
                />
                <p className="text-xs text-muted-foreground mt-0.5">Min seconds between replies</p>
              </div>
              <div>
                <Label className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Typing Delay (ms)
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={10000}
                  step={500}
                  value={typingDelayMs}
                  onChange={(e) => setTypingDelayMs(e.target.value ? Number(e.target.value) : "")}
                />
                <p className="text-xs text-muted-foreground mt-0.5">Simulated typing time</p>
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!agentName.trim() || (!useBuiltInRag && !ragBaseUrl.trim()) || saveMutation.isPending}
              className="flex-1"
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Save Settings
            </Button>
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <TestTube2 className="w-4 h-4 mr-2" />}
              Test Connection
            </Button>
          </div>

          {config && (
            <div className="flex items-center gap-2 text-sm">
              {config.isActive !== "false" ? (
                <>
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="text-muted-foreground">RAG agent is active: <strong>{config.agentName}</strong></span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-yellow-500" />
                  <span className="text-muted-foreground">RAG agent is paused</span>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {leadAutomationAllowed && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="w-4 h-4 text-amber-500" />
              Scheduled Follow-ups
              {pendingFollowups.length > 0 && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({pendingFollowups.length} pending)
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingFollowups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No follow-ups queued. When the bot decides to check back with a lead, it will appear here.
              </p>
            ) : (
              <div className="space-y-2">
                {pendingFollowups.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start justify-between gap-3 p-3 border rounded-lg"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{f.phoneNumber}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{f.message}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <Clock className="w-3 h-3 inline mr-1" />
                        {new Date(f.scheduledAt).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => cancelFollowupMutation.mutate(f.id)}
                      disabled={cancelFollowupMutation.isPending}
                      className="text-destructive hover:text-destructive shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {leadAutomationAllowed && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <GitBranch className="w-4 h-4 text-amber-500" />
              Lead Pipelines
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                (Google Sheet → webhook ingest)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Create a pipeline, then paste the generated Apps Script into your Google Sheet. New rows
              (with a <span className="font-mono">phone</span> column) are pushed here and tagged to this pipeline.
            </p>

            {/* Create */}
            <div className="flex gap-2">
              <Input
                placeholder="New pipeline name (e.g. Website Enquiries)"
                value={newPipelineName}
                onChange={(e) => setNewPipelineName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newPipelineName.trim()) createPipelineMutation.mutate(newPipelineName.trim());
                }}
              />
              <Button
                onClick={() => createPipelineMutation.mutate(newPipelineName.trim())}
                disabled={!newPipelineName.trim() || createPipelineMutation.isPending}
              >
                <Plus className="w-4 h-4 mr-1" /> Add
              </Button>
            </div>

            {/* List */}
            {(pipelines || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No pipelines yet.</p>
            ) : (
              <div className="space-y-3">
                {(pipelines || []).map((p) => (
                  <PipelineRow
                    key={p.id}
                    pipeline={p}
                    webhookUrl={webhookUrl}
                    appsScriptFor={appsScriptFor}
                    copyToClipboard={copyToClipboard}
                    onDelete={() => deletePipelineMutation.mutate(p.id)}
                    onRotate={() => rotateTokenMutation.mutate(p.id)}
                    onSaveDrip={(dripEnabled, dripPrompt) => saveDripMutation.mutate({ id: p.id, dripEnabled, dripPrompt })}
                    onSaveTemplate={(dripTemplate) => saveTemplateMutation.mutate({ id: p.id, dripTemplate })}
                    savingDrip={saveDripMutation.isPending}
                    savingTemplate={saveTemplateMutation.isPending}
                    busy={deletePipelineMutation.isPending || rotateTokenMutation.isPending}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PipelineRow({
  pipeline,
  webhookUrl,
  appsScriptFor,
  copyToClipboard,
  onDelete,
  onRotate,
  onSaveDrip,
  onSaveTemplate,
  savingDrip,
  savingTemplate,
  busy,
}: {
  pipeline: any;
  webhookUrl: string;
  appsScriptFor: (token: string) => string;
  copyToClipboard: (text: string, label: string) => void;
  onDelete: () => void;
  onRotate: () => void;
  onSaveDrip: (dripEnabled: boolean, dripPrompt: string) => void;
  onSaveTemplate: (dripTemplate: Array<{ delay: string; message: string }>) => void;
  savingDrip: boolean;
  savingTemplate: boolean;
  busy: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const [dripEnabled, setDripEnabled] = useState(pipeline.dripEnabled === "true");
  const [dripPrompt, setDripPrompt] = useState(pipeline.dripPrompt || "");
  const [steps, setSteps] = useState<Array<{ delay: string; message: string }>>(
    Array.isArray(pipeline.dripTemplate) ? pipeline.dripTemplate.map((m: any) => ({ delay: m.delay, message: m.message })) : []
  );
  // Re-sync the editable steps whenever the pipeline is saved/regenerated server-side.
  useEffect(() => {
    setSteps(Array.isArray(pipeline.dripTemplate) ? pipeline.dripTemplate.map((m: any) => ({ delay: m.delay, message: m.message })) : []);
  }, [pipeline.updatedAt]);
  const updateStep = (i: number, field: "delay" | "message", value: string) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i));
  const addStep = () => setSteps((prev) => [...prev, { delay: "1d", message: "" }]);
  const maskedToken = `${String(pipeline.ingestToken).slice(0, 6)}${"•".repeat(12)}`;

  return (
    <div className="p-3 border rounded-lg space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium truncate">{pipeline.name}</p>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" title="Rotate token" onClick={onRotate} disabled={busy}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Delete pipeline"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground w-16 shrink-0">Webhook</span>
        <code className="flex-1 truncate bg-muted px-2 py-1 rounded">{webhookUrl}</code>
        <Button variant="ghost" size="sm" onClick={() => copyToClipboard(webhookUrl, "Webhook URL")}>
          <Copy className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground w-16 shrink-0">Token</span>
        <code className="flex-1 truncate bg-muted px-2 py-1 rounded font-mono">
          {reveal ? pipeline.ingestToken : maskedToken}
        </code>
        <Button variant="ghost" size="sm" onClick={() => setReveal(!reveal)}>
          {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => copyToClipboard(pipeline.ingestToken, "Token")}>
          <Copy className="w-3.5 h-3.5" />
        </Button>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => copyToClipboard(appsScriptFor(pipeline.ingestToken), "Apps Script")}
      >
        <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy Apps Script
      </Button>

      {/* Drip sequence */}
      <div className="pt-2 border-t space-y-2">
        <div className="flex items-center justify-between">
          <Label className="cursor-pointer flex items-center gap-1.5 text-sm">
            <CalendarClock className="w-3.5 h-3.5 text-amber-500" /> Auto-drip on new lead
            {dripEnabled && steps.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">({steps.length} msg)</span>
            )}
          </Label>
          <Switch
            checked={dripEnabled}
            onCheckedChange={(v) => {
              setDripEnabled(v);
              if (!v) onSaveDrip(false, dripPrompt); // persist disable immediately
            }}
          />
        </div>
        {dripEnabled && (
          <>
            <Textarea
              placeholder='e.g. "Send 4 messages on day 1: a warm welcome, a key benefit, a short success story, and a soft CTA to book a call. Space them a few hours apart. Address the lead as {{name}}."'
              value={dripPrompt}
              onChange={(e) => setDripPrompt(e.target.value)}
              rows={3}
              className="text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSaveDrip(dripEnabled, dripPrompt)}
              disabled={savingDrip || !dripPrompt.trim()}
            >
              {savingDrip ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Generate from prompt
            </Button>

            {steps.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-xs font-medium text-muted-foreground">Messages — edit the time &amp; text, then save</p>
                {steps.map((s, i) => (
                  <div key={i} className="border rounded-lg p-2.5 space-y-2 bg-background">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground shrink-0">Send after</span>
                      <Input
                        value={s.delay}
                        onChange={(e) => updateStep(i, "delay", e.target.value)}
                        placeholder="2h"
                        className="h-7 w-20 text-xs font-mono"
                      />
                      <span className="text-xs text-muted-foreground shrink-0">m / h / d / w</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-7 text-destructive hover:text-destructive"
                        onClick={() => removeStep(i)}
                        title="Remove message"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    <Textarea
                      value={s.message}
                      onChange={(e) => updateStep(i, "message", e.target.value)}
                      rows={2}
                      placeholder="Message text… use {{name}} for the lead's name"
                      className="text-sm"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={addStep}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add message
              </Button>
              <Button
                size="sm"
                onClick={() => onSaveTemplate(steps.filter((s) => s.message.trim()))}
                disabled={savingTemplate || steps.length === 0}
              >
                {savingTemplate ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
                Save messages
              </Button>
            </div>

            {steps.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Write a prompt and "Generate from prompt", or "Add message" to build the sequence by hand.
                It is scheduled for every new lead; a reply stops the rest.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
