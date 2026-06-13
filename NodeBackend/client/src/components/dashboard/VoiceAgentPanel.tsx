import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Mic, Plus, Upload } from "lucide-react";

const defaultFlow = JSON.stringify({
  id: "welcome_flow",
  startNode: "welcome",
  nodes: {
    welcome: {
      id: "welcome",
      type: "speak",
      text: "Hello. How can I help you today?",
      next: "listen"
    },
    listen: {
      id: "listen",
      type: "listen",
      prompt: "Please tell me what you need.",
      intents: { stop: "end", unclear: "listen" }
    },
    end: { id: "end", type: "end" }
  }
}, null, 2);

export function VoiceAgentPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [credential, setCredential] = useState({ provider: "fish", credentialType: "tts", name: "Fish Audio", secret: "", language: "auto" });
  const [profile, setProfile] = useState({ credentialId: "", name: "Default Voice", referenceId: "", model: "s2-pro" });
  const [agent, setAgent] = useState({ name: "Voice Agent", sttCredentialId: "", voiceProfileId: "", defaultFlowKey: "welcome_flow", languageMode: "match_speaker" });
  const [flow, setFlow] = useState({ flowKey: "welcome_flow", name: "Welcome Flow", voiceAgentId: "", voiceProfileId: "", definition: defaultFlow });
  const [gatewayName, setGatewayName] = useState("Windows Gateway");
  const [campaign, setCampaign] = useState({ name: "Voice Campaign", voiceAgentId: "", flowId: "", gatewayDeviceId: "" });
  const [contactText, setContactText] = useState("");
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [enrollment, setEnrollment] = useState<any>(null);

  const { data: credentials = [], isLoading } = useQuery<any[]>({ queryKey: ["/api/voice/credentials"] });
  const { data: profiles = [] } = useQuery<any[]>({ queryKey: ["/api/voice/profiles"] });
  const { data: agents = [] } = useQuery<any[]>({ queryKey: ["/api/voice/agents"] });
  const { data: flows = [] } = useQuery<any[]>({ queryKey: ["/api/voice/flows"] });
  const { data: gateways = [] } = useQuery<any[]>({ queryKey: ["/api/voice/gateways"], refetchInterval: 5000 });
  const { data: campaigns = [] } = useQuery<any[]>({ queryKey: ["/api/voice/campaigns"], refetchInterval: 5000 });
  const { data: calls = [] } = useQuery<any[]>({ queryKey: ["/api/voice/calls"], refetchInterval: 3000 });
  const { data: usage = [] } = useQuery<any[]>({ queryKey: ["/api/voice/usage"], refetchInterval: 10000 });

  const ttsCredentials = useMemo(() => credentials.filter((item) => item.credentialType === "tts"), [credentials]);
  const sttCredentials = useMemo(() => credentials.filter((item) => item.credentialType === "stt"), [credentials]);

  const refresh = () => {
    ["/api/voice/credentials", "/api/voice/profiles", "/api/voice/agents", "/api/voice/flows", "/api/voice/gateways", "/api/voice/campaigns", "/api/voice/calls", "/api/voice/usage"]
      .forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
  };

  const createCredential = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/voice/credentials", {
        provider: credential.provider,
        credentialType: credential.credentialType,
        name: credential.name,
        secret: credential.secret,
        settings: credential.credentialType === "stt" && credential.language !== "auto"
          ? { language: credential.language }
          : {},
      });
      return response.json();
    },
    onSuccess: () => {
      setCredential({ ...credential, secret: "" });
      refresh();
      toast({ title: "Credential saved securely" });
    },
    onError: showError(toast),
  });

  const createProfile = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/voice/profiles", {
        ...profile,
        provider: "fish",
        audioFormat: "pcm",
        settings: { sampleRate: 16000 },
      });
      return response.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Voice profile created" });
    },
    onError: showError(toast),
  });

  const createAgent = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/voice/agents", {
        ...agent,
        sttCredentialId: agent.sttCredentialId || undefined,
        voiceProfileId: agent.voiceProfileId || undefined,
      });
      return response.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Voice agent created" });
    },
    onError: showError(toast),
  });

  const createFlow = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/voice/flows", {
        ...flow,
        voiceAgentId: flow.voiceAgentId || undefined,
        voiceProfileId: flow.voiceProfileId || undefined,
        definition: JSON.parse(flow.definition),
      });
      return response.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Flow draft saved" });
    },
    onError: showError(toast),
  });

  const publishFlow = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("POST", `/api/voice/flows/${id}/publish`, {});
      return response.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Flow published" });
    },
    onError: showError(toast),
  });

  const enrollGateway = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/voice/gateways/enroll", { name: gatewayName, deviceType: "windows", capabilities: { wasapi: true } });
      return response.json();
    },
    onSuccess: (data) => { setEnrollment(data); refresh(); toast({ title: "Gateway enrolled", description: "Store the device token now; it is shown once." }); },
    onError: showError(toast),
  });

  const createCampaign = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/voice/campaigns", campaign);
      return response.json();
    },
    onSuccess: (data) => { setSelectedCampaign(data.id); refresh(); toast({ title: "Campaign created" }); },
    onError: showError(toast),
  });

  const addContacts = useMutation({
    mutationFn: async () => {
      const contacts = contactText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [phoneNumber, name] = line.split(",").map((value) => value.trim());
        return { phoneNumber, name };
      });
      const response = await apiRequest("POST", `/api/voice/campaigns/${selectedCampaign}/contacts`, { contacts });
      return response.json();
    },
    onSuccess: () => { setContactText(""); refresh(); toast({ title: "Contacts queued" }); },
    onError: showError(toast),
  });

  const campaignAction = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "start" | "pause" }) => {
      const response = await apiRequest("POST", `/api/voice/campaigns/${id}/${action}`, {});
      return response.json();
    },
    onSuccess: refresh,
    onError: showError(toast),
  });

  if (isLoading) return <Loader2 className="w-6 h-6 animate-spin" />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2"><Mic className="w-6 h-6" /> Voice Service</h2>
        <p className="text-sm text-muted-foreground">Tenant-owned providers, voices, agents, and published flows.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Provider Credential</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Name"><Input value={credential.name} onChange={(e) => setCredential({ ...credential, name: e.target.value })} /></Field>
            <Field label="Provider">
              <select className="w-full border rounded-md p-2 bg-background" value={credential.provider} onChange={(e) => setCredential({ ...credential, provider: e.target.value })}>
                <option value="fish">Fish Audio</option><option value="openai">OpenAI</option><option value="http">Custom HTTP</option>
              </select>
            </Field>
            <Field label="Use for">
              <select className="w-full border rounded-md p-2 bg-background" value={credential.credentialType} onChange={(e) => setCredential({ ...credential, credentialType: e.target.value })}>
                <option value="tts">Text to speech</option><option value="stt">Speech to text</option>
              </select>
            </Field>
            <Field label="API key"><Input type="password" value={credential.secret} onChange={(e) => setCredential({ ...credential, secret: e.target.value })} /></Field>
            {credential.credentialType === "stt" && (
              <Field label="Recognition language">
                <select className="w-full border rounded-md p-2 bg-background" value={credential.language} onChange={(e) => setCredential({ ...credential, language: e.target.value })}>
                  <option value="auto">Detect automatically</option>
                  <option value="en">English</option>
                  <option value="hi">Hindi</option>
                  <option value="bn">Bengali</option>
                  <option value="ta">Tamil</option>
                  <option value="te">Telugu</option>
                  <option value="mr">Marathi</option>
                  <option value="gu">Gujarati</option>
                  <option value="kn">Kannada</option>
                  <option value="ml">Malayalam</option>
                  <option value="pa">Punjabi</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="ar">Arabic</option>
                </select>
              </Field>
            )}
            <Button onClick={() => createCredential.mutate()} disabled={!credential.secret || createCredential.isPending}><Plus className="w-4 h-4 mr-2" />Save credential</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Fish Voice Profile</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Profile name"><Input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></Field>
            <Field label="Fish credential">
              <Select value={profile.credentialId} onChange={(value) => setProfile({ ...profile, credentialId: value })} items={ttsCredentials} />
            </Field>
            <Field label="Fish reference ID"><Input value={profile.referenceId} onChange={(e) => setProfile({ ...profile, referenceId: e.target.value })} /></Field>
            <Field label="Model"><Input value={profile.model} onChange={(e) => setProfile({ ...profile, model: e.target.value })} /></Field>
            <Button onClick={() => createProfile.mutate()} disabled={!profile.credentialId || !profile.referenceId || createProfile.isPending}><Plus className="w-4 h-4 mr-2" />Create profile</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Voice Agent</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Agent name"><Input value={agent.name} onChange={(e) => setAgent({ ...agent, name: e.target.value })} /></Field>
            <Field label="STT credential"><Select optional value={agent.sttCredentialId} onChange={(value) => setAgent({ ...agent, sttCredentialId: value })} items={sttCredentials} /></Field>
            <Field label="Voice profile"><Select optional value={agent.voiceProfileId} onChange={(value) => setAgent({ ...agent, voiceProfileId: value })} items={profiles} /></Field>
            <Field label="Response language">
              <select className="w-full border rounded-md p-2 bg-background" value={agent.languageMode} onChange={(e) => setAgent({ ...agent, languageMode: e.target.value })}>
                <option value="match_speaker">Match the speaker automatically</option>
                <option value="fixed:English">Always English</option>
                <option value="fixed:Hindi">Always Hindi</option>
                <option value="fixed:Bengali">Always Bengali</option>
                <option value="fixed:Tamil">Always Tamil</option>
                <option value="fixed:Telugu">Always Telugu</option>
                <option value="fixed:Marathi">Always Marathi</option>
                <option value="fixed:Gujarati">Always Gujarati</option>
                <option value="fixed:Kannada">Always Kannada</option>
                <option value="fixed:Malayalam">Always Malayalam</option>
                <option value="fixed:Punjabi">Always Punjabi</option>
                <option value="fixed:Spanish">Always Spanish</option>
                <option value="fixed:French">Always French</option>
                <option value="fixed:Arabic">Always Arabic</option>
              </select>
            </Field>
            <Field label="Default flow key"><Input value={agent.defaultFlowKey} onChange={(e) => setAgent({ ...agent, defaultFlowKey: e.target.value })} /></Field>
            <Button onClick={() => createAgent.mutate()} disabled={!agent.name || createAgent.isPending}><Plus className="w-4 h-4 mr-2" />Create agent</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Versioned Flow</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Flow key"><Input value={flow.flowKey} onChange={(e) => setFlow({ ...flow, flowKey: e.target.value })} /></Field>
            <Field label="Name"><Input value={flow.name} onChange={(e) => setFlow({ ...flow, name: e.target.value })} /></Field>
            <Field label="Agent"><Select optional value={flow.voiceAgentId} onChange={(value) => setFlow({ ...flow, voiceAgentId: value })} items={agents} /></Field>
            <Field label="Voice profile"><Select optional value={flow.voiceProfileId} onChange={(value) => setFlow({ ...flow, voiceProfileId: value })} items={profiles} /></Field>
            <Field label="Flow JSON"><Textarea className="font-mono text-xs min-h-64" value={flow.definition} onChange={(e) => setFlow({ ...flow, definition: e.target.value })} /></Field>
            <Button onClick={() => createFlow.mutate()} disabled={createFlow.isPending}><Plus className="w-4 h-4 mr-2" />Save new draft version</Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Saved Flows</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {flows.length === 0 && <p className="text-sm text-muted-foreground">No flows created yet.</p>}
          {flows.map((item) => (
            <div key={item.id} className="flex items-center justify-between border rounded-lg p-3">
              <div><div className="font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{item.flowKey} v{item.version} · {item.status}</div></div>
              {item.status === "draft" && <Button size="sm" onClick={() => publishFlow.mutate(item.id)}><Upload className="w-4 h-4 mr-2" />Publish</Button>}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Windows Gateway Enrollment</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Gateway name"><Input value={gatewayName} onChange={(e) => setGatewayName(e.target.value)} /></Field>
            <Button onClick={() => enrollGateway.mutate()} disabled={enrollGateway.isPending}>Enroll gateway</Button>
            {enrollment && (
              <div className="rounded-md border p-3 text-xs font-mono break-all">
                <div>Device ID: {enrollment.id}</div>
                <div>Device token: {enrollment.deviceToken}</div>
              </div>
            )}
            {gateways.map((item) => <div key={item.id} className="text-sm border rounded p-2">{item.name} · {item.status}</div>)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Voice Campaign</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Campaign name"><Input value={campaign.name} onChange={(e) => setCampaign({ ...campaign, name: e.target.value })} /></Field>
            <Field label="Agent"><Select value={campaign.voiceAgentId} onChange={(value) => setCampaign({ ...campaign, voiceAgentId: value })} items={agents} /></Field>
            <Field label="Published flow">
              <Select value={campaign.flowId} onChange={(value) => setCampaign({ ...campaign, flowId: value })} items={flows.filter((item) => item.status === "published")} />
            </Field>
            <Field label="Windows gateway"><Select value={campaign.gatewayDeviceId} onChange={(value) => setCampaign({ ...campaign, gatewayDeviceId: value })} items={gateways} /></Field>
            <Button onClick={() => createCampaign.mutate()} disabled={!campaign.voiceAgentId || !campaign.flowId || !campaign.gatewayDeviceId}>Create campaign</Button>
            <Field label="Contacts: phone,name per line"><Textarea value={contactText} onChange={(e) => setContactText(e.target.value)} /></Field>
            <Field label="Campaign"><Select value={selectedCampaign} onChange={setSelectedCampaign} items={campaigns} /></Field>
            <Button variant="secondary" onClick={() => addContacts.mutate()} disabled={!selectedCampaign || !contactText.trim()}>Queue contacts</Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Campaign Queue</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {campaigns.map((item) => (
            <div key={item.id} className="flex items-center justify-between border rounded p-3">
              <div><div className="font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{item.status}</div></div>
              <div className="flex gap-2">
                {item.status !== "running" && <Button size="sm" onClick={() => campaignAction.mutate({ id: item.id, action: "start" })}>Start</Button>}
                {item.status === "running" && <Button size="sm" variant="secondary" onClick={() => campaignAction.mutate({ id: item.id, action: "pause" })}>Pause</Button>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Live Calls and Transcripts</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {calls.length === 0 && <p className="text-sm text-muted-foreground">No call sessions yet.</p>}
          {calls.map((call) => (
            <div key={call.id} className="border rounded-lg p-3">
              <div className="flex justify-between"><span className="font-medium">{call.phoneNumber}</span><span className="text-sm">{call.status}</span></div>
              <div className="text-xs text-muted-foreground">{call.outcome || call.transport}</div>
              <div className="mt-2 space-y-1">
                {(Array.isArray(call.transcript) ? call.transcript : []).map((line: any, index: number) => (
                  <div key={index} className="text-sm"><b>{line.speaker}:</b> {line.text}</div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Usage</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {usage.map((item, index) => <div key={index} className="border rounded p-3 text-sm">{item.metric}: {item.quantity} {item.unit}</div>)}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label>{label}</Label>{children}</div>;
}

function Select({ value, onChange, items, optional }: { value: string; onChange: (value: string) => void; items: any[]; optional?: boolean }) {
  return (
    <select className="w-full border rounded-md p-2 bg-background" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{optional ? "Use default" : "Select"}</option>
      {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
  );
}

function showError(toast: ReturnType<typeof useToast>["toast"]) {
  return (error: any) => toast({ title: "Voice service error", description: error.message, variant: "destructive" });
}
