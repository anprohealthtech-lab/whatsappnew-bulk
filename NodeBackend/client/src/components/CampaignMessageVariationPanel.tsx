import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAuthToken } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Upload, Send, RefreshCw, Plus, Trash2, Link, MessageSquare, AlertCircle, FileText, Users, Download, Info, CheckCircle } from 'lucide-react';

interface Campaign {
  id: string;
  name: string;
  originalMessage: string;
  fixedParams: Record<string, any>;
  selectedVariation?: string;
  totalContacts: number;
  attachmentName?: string;
}

interface MessageVariation {
  id: string;
  variation: string;
  createdAt: string;
}

interface Contact {
  name: string;
  phone: string;
  extra?: Record<string, any>;
}

interface CampaignMessageVariationPanelProps {
  campaignId?: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  edgeFunctionUrl: string;
  onCampaignCreated?: () => void;
}

export function CampaignMessageVariationPanel({
  campaignId: initialCampaignId,
  supabaseUrl,
  supabaseAnonKey,
  edgeFunctionUrl,
  onCampaignCreated,
}: CampaignMessageVariationPanelProps) {
  const queryClient = useQueryClient();
  const [campaignId, setCampaignId] = useState(initialCampaignId || '');
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [variations, setVariations] = useState<MessageVariation[]>([]);
  const [selectedVariation, setSelectedVariation] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  // New campaign form state
  const [newCampaignName, setNewCampaignName] = useState('');
  const [originalMessage, setOriginalMessage] = useState('');
  const [fixedParams, setFixedParams] = useState<Record<string, string>>({});
  const [buttons, setButtons] = useState<Array<{ text: string; url?: string }>>([]);
  const [showButtons, setShowButtons] = useState(false);
  const [includeStopButton, setIncludeStopButton] = useState(false);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);

  // Extract placeholders from message
  const extractPlaceholders = (message: string): string[] => {
    const regex = /\{\{(\w+)\}\}/g;
    const placeholders = new Set<string>();
    let match;

    while ((match = regex.exec(message)) !== null) {
      if (match[1] !== 'name') { // Exclude {{name}} as it's per-contact
        placeholders.add(match[1]);
      }
    }

    return Array.from(placeholders);
  };

  // Update fixed params when a field changes
  const updateFixedParam = (key: string, value: string) => {
    setFixedParams(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // Add/remove/update buttons
  const addButton = () => {
    setButtons(prev => [...prev, { text: '', url: '' }]);
  };

  const updateButton = (index: number, field: 'text' | 'url', value: string) => {
    setButtons(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeButton = (index: number) => {
    setButtons(prev => prev.filter((_, i) => i !== index));
  };

  // Get placeholders from current message
  const placeholders = extractPlaceholders(originalMessage);

  useEffect(() => {
    if (campaignId) {
      loadCampaign();
      loadContacts();
      loadVariations();
    }
  }, [campaignId]);

  const loadCampaign = async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await response.json();

      if (data.success) {
        setCampaign(data.data);
        setSelectedVariation(data.data.selectedVariation || '');
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError('Failed to load campaign: ' + err.message);
    }
  };

  const loadContacts = async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/contacts`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await response.json();

      if (data.success) {
        setContacts(data.data);
      }
    } catch (err: any) {
      setError('Failed to load contacts: ' + err.message);
    }
  };

  const loadVariations = async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/variations`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await response.json();

      if (data.success) {
        setVariations(data.data);
      }
    } catch (err: any) {
      setError('Failed to load variations: ' + err.message);
    }
  };

  const createCampaign = async () => {
    try {
      setError('');

      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
        body: JSON.stringify({
          name: newCampaignName,
          originalMessage,
          fixedParams,
          buttons: buttons.filter(b => b.text.trim() !== ''), // Only send non-empty buttons
          includeStopButton, // Add stop button option
        }),
      });

      const data = await response.json();

      if (data.success) {
        const newCampaignId = data.data.id;

        // Upload attachment if present
        if (attachmentFile) {
          try {
            const formData = new FormData();
            formData.append('file', attachmentFile);
            await fetch(`/api/campaigns/${newCampaignId}/attachment`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${getAuthToken()}` },
              body: formData,
            });
          } catch (uploadErr) {
            console.error('Failed to upload attachment:', uploadErr);
            // Don't fail the whole campaign creation, just log it
          }
        }

        setCampaignId(newCampaignId);
        setCampaign(data.data);
        setSuccess('Campaign created successfully!');
        setNewCampaignName('');
        setOriginalMessage('');
        setFixedParams({});
        setAttachmentFile(null);
        // Invalidate campaign list cache so ScheduleCampaignPanel and other lists update
        queryClient.invalidateQueries({ queryKey: ['/api/campaigns'] });
        onCampaignCreated?.();
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError('Failed to create campaign: ' + err.message);
    }
  };

  const generateVariation = async () => {
    if (!campaign) return;

    try {
      setIsGenerating(true);
      setError('');

      // Call Supabase Edge Function
      const response = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({
          message: campaign.originalMessage,
          campaign_id: campaignId,
          fixed_params: {
            name_placeholder: '{{name}}',
            ...campaign.fixedParams,
          },
        }),
      });

      const data = await response.json();

      if (data.success && data.tweaked_message) {
        // Save variation to database
        const saveResponse = await fetch(`/api/campaigns/${campaignId}/variations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify({ variation: data.tweaked_message }),
        });

        if (saveResponse.ok) {
          setSelectedVariation(data.tweaked_message);
          await loadVariations();
          setSuccess('New variation generated successfully!');
        }
      } else {
        setError('Failed to generate variation');
      }
    } catch (err: any) {
      setError('Failed to generate variation: ' + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAttachmentUpdate = async (file: File) => {
    if (!campaignId) return;

    try {
      setIsUploading(true);
      setError('');

      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`/api/campaigns/${campaignId}/attachment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        setSuccess('Attachment updated successfully!');
        await loadCampaign();
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError('Failed to upload attachment: ' + err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileUpload = async () => {
    if (!uploadFile || !campaignId) return;

    try {
      setIsUploading(true);
      setError('');

      const formData = new FormData();
      formData.append('file', uploadFile);

      const response = await fetch(`/api/campaigns/${campaignId}/contacts/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(`Contacts loaded: ${data.total}`);
        await loadContacts();
        await loadCampaign();
        setUploadFile(null);
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError('Failed to upload contacts: ' + err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const sendBulkMessages = async () => {
    if (!selectedVariation) {
      setError('Generate or select a variation first');
      return;
    }

    if (contacts.length === 0) {
      setError('Upload contact list first');
      return;
    }

    if (!confirm(`Send campaign to ${contacts.length} contacts? This will take ${Math.ceil(contacts.length * 1.25)} minutes.`)) {
      return;
    }

    try {
      setIsSending(true);
      setError('');

      const response = await fetch(`/api/campaigns/${campaignId}/send-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
        body: JSON.stringify({
          variation_message: selectedVariation,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(`Campaign sent! Total: ${data.total}, Sent: ${data.sent}, Failed: ${data.failed}`);
        if (data.failed > 0) {
          console.log('Failed contacts:', data.failed_list);
        }
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError('Failed to send campaign: ' + err.message);
    } finally {
      setIsSending(false);
    }
  };

  if (!campaignId) {
    return (
      <Card className="w-full max-w-4xl mx-auto border-none shadow-xl bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold flex items-center">
            <Plus className="w-6 h-6 mr-2 text-primary" />
            Create New Campaign
          </CardTitle>
          <CardDescription>Set up a new WhatsApp campaign with message variations</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert className="bg-green-50 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-900/30">
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="campaignName">Campaign Name</Label>
            <Input
              id="campaignName"
              value={newCampaignName}
              onChange={(e) => setNewCampaignName(e.target.value)}
              placeholder="e.g., Appointment Reminders"
              className="bg-white dark:bg-zinc-950"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="originalMessage">Original Message Template</Label>
            <Textarea
              id="originalMessage"
              value={originalMessage}
              onChange={(e) => setOriginalMessage(e.target.value)}
              placeholder="Hi {{name}}, reminder for your appointment on {{date}} at {{time}}."
              rows={4}
              className="bg-white dark:bg-zinc-950 resize-none"
            />
            <p className="text-sm text-muted-foreground flex items-center">
              <Info className="w-3 h-3 mr-1" />
              Use {'{{name}}'} for recipient name. Other placeholders like {'{{date}}'}, {'{{time}}'} will show as fields below.
            </p>
          </div>

          {placeholders.length > 0 && (
            <div className="space-y-4 border border-border rounded-xl p-6 bg-accent/20">
              <Label className="text-base font-semibold flex items-center">
                <FileText className="w-4 h-4 mr-2" />
                Fixed Parameters
              </Label>
              <p className="text-sm text-muted-foreground">
                Fill in values for placeholders found in your message:
              </p>
              {placeholders.map((placeholder) => (
                <div key={placeholder} className="space-y-2">
                  <Label htmlFor={placeholder} className="flex items-center gap-2">
                    <code className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                      {'{{' + placeholder + '}}'}
                    </code>
                    {placeholder.charAt(0).toUpperCase() + placeholder.slice(1)}
                  </Label>
                  <Input
                    id={placeholder}
                    value={fixedParams[placeholder] || ''}
                    onChange={(e) => updateFixedParam(placeholder, e.target.value)}
                    placeholder={`Enter value for ${placeholder}`}
                    className="bg-white dark:bg-zinc-950"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Button Configuration Section */}
          <div className="space-y-4 border border-border rounded-xl p-6 bg-accent/20">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base font-semibold flex items-center">
                  <Link className="w-4 h-4 mr-2" />
                  Interactive Buttons (Optional)
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  Add clickable links to reduce spam reports and boost engagement
                </p>
              </div>
              <Button
                variant={showButtons ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowButtons(!showButtons)}
              >
                {showButtons ? 'Hide' : 'Show'} Buttons
              </Button>
            </div>

            {showButtons && (
              <div className="space-y-4 mt-4 animate-in fade-in slide-in-from-top-2">
                {buttons.map((button, index) => (
                  <div key={index} className="flex gap-2 items-end">
                    <div className="flex-1 space-y-2">
                      <Label htmlFor={`btn-text-${index}`}>Button Text</Label>
                      <Input
                        id={`btn-text-${index}`}
                        value={button.text}
                        onChange={(e) => updateButton(index, 'text', e.target.value)}
                        placeholder="e.g., Visit Website"
                        className="bg-white dark:bg-zinc-950"
                      />
                    </div>
                    <div className="flex-1 space-y-2">
                      <Label htmlFor={`btn-url-${index}`}>URL (optional)</Label>
                      <Input
                        id={`btn-url-${index}`}
                        value={button.url || ''}
                        onChange={(e) => updateButton(index, 'url', e.target.value)}
                        placeholder="https://example.com"
                        className="bg-white dark:bg-zinc-950"
                      />
                    </div>
                    <Button
                      variant="destructive"
                      size="icon"
                      onClick={() => removeButton(index)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" onClick={addButton} className="w-full border-dashed">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Button
                </Button>
                <Alert className="bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-900/30">
                  <Info className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    <strong>Tip:</strong> Add a "Visit Website" button or "This is helpful" to encourage positive interaction and reduce spam reports.
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </div>

          {/* Stop Button Option */}
          <div className="space-y-2 border border-border rounded-xl p-6 bg-accent/20">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="includeStopButton"
                checked={includeStopButton}
                onCheckedChange={(checked) => setIncludeStopButton(checked as boolean)}
              />
              <Label htmlFor="includeStopButton" className="text-base font-semibold cursor-pointer">
                Include "Stop Messages" Quick Reply Button
              </Label>
            </div>
            <p className="text-sm text-muted-foreground ml-6">
              Users can tap to instantly unsubscribe. Numbers will be automatically blocked from future campaigns.
            </p>
            {includeStopButton && (
              <Alert className="ml-6 mt-2 bg-green-50 text-green-800 border-green-200">
                <CheckCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  When enabled, messages will include a quick reply button saying "🚫 Stop Receiving Messages" that users can tap to opt out.
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* Attachment Upload */}
          <div className="space-y-2 border border-border rounded-xl p-6 bg-accent/20">
            <Label htmlFor="attachment" className="text-base font-semibold flex items-center">
              <Upload className="w-4 h-4 mr-2" />
              Attachment (Optional)
            </Label>
            <div className="border-2 border-dashed border-border rounded-xl p-6 text-center hover:border-primary/50 hover:bg-primary/5 transition-all duration-300 cursor-pointer group bg-background/50">
              <input
                type="file"
                id="attachment"
                onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)}
                className="hidden"
              />
              <label htmlFor="attachment" className="cursor-pointer w-full h-full block">
                {attachmentFile ? (
                  <div className="flex items-center justify-center text-primary">
                    <FileText className="w-8 h-8 mr-2" />
                    <span className="font-medium">{attachmentFile.name}</span>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground group-hover:text-primary transition-colors" />
                    <p className="font-medium text-sm text-foreground">
                      Click to upload image or document
                    </p>
                  </>
                )}
              </label>
            </div>
          </div>

          <Button onClick={createCampaign} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20">
            Create Campaign
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto">
      {/* Campaign Info */}
      {campaign && (
        <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl">{campaign.name}</CardTitle>
                <CardDescription>Campaign ID: {campaignId}</CardDescription>
              </div>
              <Badge variant="secondary" className="text-sm px-3 py-1">
                <Users className="w-4 h-4 mr-2" />
                {campaign.totalContacts} Contacts
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Original Message</Label>
                <div className="mt-2 p-4 bg-muted/50 rounded-xl border border-border text-sm">
                  {campaign.originalMessage}
                </div>
              </div>
            </div>

            <div className="space-y-2 mt-4">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Attachment</Label>

              {campaign.attachmentName ? (
                <div className="p-3 bg-muted/50 rounded-xl border border-border text-sm flex items-center justify-between">
                  <div className="flex items-center overflow-hidden">
                    <FileText className="w-4 h-4 mr-2 text-primary flex-shrink-0" />
                    <span className="truncate">{campaign.attachmentName}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => window.open(`/api/campaigns/${campaignId}/attachment/download`, '_blank')}
                      className="h-8 px-2"
                    >
                      <Download className="w-4 h-4 mr-1" />
                      Download
                    </Button>
                    <div className="relative">
                      <input
                        type="file"
                        id="update-attachment"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleAttachmentUpdate(file);
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        disabled={isUploading}
                        onClick={() => document.getElementById('update-attachment')?.click()}
                      >
                        {isUploading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Upload className="w-4 h-4 mr-1" />
                            Update
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="border-2 border-dashed border-border rounded-xl p-4 text-center hover:border-primary/50 hover:bg-primary/5 transition-all duration-300 cursor-pointer group bg-background/50">
                  <input
                    type="file"
                    id="add-attachment"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleAttachmentUpdate(file);
                    }}
                  />
                  <label htmlFor="add-attachment" className="cursor-pointer w-full h-full flex flex-col items-center justify-center py-2">
                    {isUploading ? (
                      <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
                    ) : (
                      <>
                        <Upload className="w-6 h-6 mb-2 text-muted-foreground group-hover:text-primary transition-colors" />
                        <p className="font-medium text-sm text-foreground">
                          Upload Attachment
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Click to add a file
                        </p>
                      </>
                    )}
                  </label>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )
      }

      {/* Upload Recipients Panel */}
      <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Users className="w-5 h-5 mr-2 text-primary" />
            Upload Recipients
          </CardTitle>
          <CardDescription>Upload contacts from Excel file (.xlsx, .xls, .csv)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-primary/50 hover:bg-primary/5 transition-all duration-300 cursor-pointer group">
              <input
                type="file"
                id="contactFile"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                className="hidden"
              />
              <label htmlFor="contactFile" className="cursor-pointer w-full h-full block">
                <Upload className="w-12 h-12 mx-auto mb-4 text-muted-foreground group-hover:text-primary transition-colors" />
                <p className="font-medium text-foreground">
                  {uploadFile ? uploadFile.name : "Click to upload or drag and drop"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Expected columns: <strong>name</strong>, <strong>phone</strong>
                </p>
              </label>
            </div>
          </div>

          <Button
            onClick={handleFileUpload}
            disabled={!uploadFile || isUploading}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
          >
            {isUploading ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading...</>
            ) : (
              <><Upload className="mr-2 h-4 w-4" /> Upload Contacts</>
            )}
          </Button>

          {contacts.length > 0 && (
            <div className="mt-4 border border-border rounded-xl overflow-hidden">
              <div className="bg-muted/50 px-4 py-2 border-b border-border flex justify-between items-center">
                <span className="font-medium text-sm">Contacts Preview</span>
                <Badge variant="outline">{contacts.length} total</Badge>
              </div>
              <div className="max-h-48 overflow-y-auto p-2 space-y-1 bg-white dark:bg-zinc-950">
                {contacts.slice(0, 10).map((contact, idx) => (
                  <div key={idx} className="text-sm px-3 py-2 rounded hover:bg-muted/50 flex justify-between">
                    <span className="font-medium">{contact.name}</span>
                    <span className="text-muted-foreground font-mono">{contact.phone}</span>
                  </div>
                ))}
                {contacts.length > 10 && (
                  <p className="text-xs text-center text-muted-foreground py-2 italic">
                    ...and {contacts.length - 10} more
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Message Variations Panel */}
      <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center">
            <MessageSquare className="w-5 h-5 mr-2 text-primary" />
            Message Variations
          </CardTitle>
          <CardDescription>Generate and manage message variations</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Button
            onClick={generateVariation}
            disabled={isGenerating}
            className="w-full bg-secondary hover:bg-secondary/80 text-secondary-foreground border border-border"
            variant="outline"
          >
            {isGenerating ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
            ) : (
              <><RefreshCw className="mr-2 h-4 w-4" /> Generate New Variation with AI</>
            )}
          </Button>

          {selectedVariation && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Current Variation</Label>
              <Textarea
                value={selectedVariation}
                onChange={(e) => setSelectedVariation(e.target.value)}
                rows={4}
                className="font-mono text-sm bg-white dark:bg-zinc-950 resize-none"
              />
            </div>
          )}

          {variations.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">History ({variations.length})</Label>
              <div className="max-h-48 overflow-y-auto border border-border rounded-xl p-2 space-y-2 bg-muted/20">
                {variations.map((v) => (
                  <div
                    key={v.id}
                    className="text-sm p-3 bg-white dark:bg-zinc-950 rounded-lg border border-border cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all"
                    onClick={() => setSelectedVariation(v.variation)}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-medium text-primary">Variation</span>
                      <span className="text-[10px] text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="text-muted-foreground line-clamp-2">{v.variation}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Send Campaign Panel */}
      <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Send className="w-5 h-5 mr-2 text-primary" />
            Send Campaign
          </CardTitle>
          <CardDescription>Bulk send messages to all contacts</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert className="bg-green-50 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-900/30">
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className={`p-4 rounded-xl border ${selectedVariation ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-900/30' : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-900/30'} transition-colors`}>
              <p className="text-xs font-medium uppercase tracking-wider mb-1">Variation</p>
              <p className={`font-semibold ${selectedVariation ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                {selectedVariation ? 'Ready' : 'Missing'}
              </p>
            </div>
            <div className={`p-4 rounded-xl border ${contacts.length > 0 ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-900/30' : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-900/30'} transition-colors`}>
              <p className="text-xs font-medium uppercase tracking-wider mb-1">Contacts</p>
              <p className={`font-semibold ${contacts.length > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                {contacts.length > 0 ? `${contacts.length} Loaded` : 'Empty'}
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <Button
              onClick={sendBulkMessages}
              disabled={isSending || !selectedVariation || contacts.length === 0}
              className="flex-1 h-12 text-lg bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
            >
              {isSending ? (
                <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Sending Campaign...</>
              ) : (
                <><Send className="mr-2 h-5 w-5" /> Send to All Contacts</>
              )}
            </Button>

            {isSending && (
              <Button
                onClick={async () => {
                  if (confirm('Are you sure you want to stop the campaign?')) {
                    try {
                      await fetch(`/api/campaigns/${campaignId}/stop`, { method: 'POST' });
                      setSuccess('Campaign stopped successfully');
                      setIsSending(false);
                    } catch (err) {
                      console.error('Failed to stop campaign:', err);
                    }
                  }
                }}
                variant="destructive"
                className="h-12 px-6"
              >
                <Trash2 className="mr-2 h-5 w-5" /> Stop
              </Button>
            )}
          </div>

          <p className="text-sm text-center text-muted-foreground">
            {contacts.length > 0 && (
              <>Estimated time: <strong>{Math.ceil(contacts.length * 1.25)} minutes</strong> (approx 1-1.5 min per contact)</>
            )}
          </p>
        </CardContent>
      </Card>
    </div >
  );
}

