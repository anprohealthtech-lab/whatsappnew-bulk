import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CampaignMessageVariationPanel } from '@/components/CampaignMessageVariationPanel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Megaphone, Plus, ChevronRight, Users } from 'lucide-react';
import { useLocation } from 'wouter';
import { getAuthToken } from '@/lib/AuthContext';

interface Campaign {
  id: string;
  name: string;
  originalMessage: string;
  totalContacts: number;
  createdAt: string;
}

export default function CampaignsPage() {
  const [, setLocation] = useLocation();
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const queryClient = useQueryClient();

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/bulk-message-generator`;

  const { data: campaigns = [], isLoading } = useQuery<Campaign[]>({
    queryKey: ['/api/campaigns'],
    queryFn: async () => {
      const res = await fetch('/api/campaigns', {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await res.json();
      return data?.data || [];
    },
    staleTime: 0,
  });

  const handleCampaignCreated = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/campaigns'] });
  };

  const showEditor = selectedCampaignId !== null || creatingNew;

  return (
    <div className="min-h-screen bg-background text-foreground overflow-y-auto">
      <div className="container mx-auto py-12 px-4 max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <Button
              variant="ghost"
              onClick={() => {
                if (showEditor) {
                  setSelectedCampaignId(null);
                  setCreatingNew(false);
                } else {
                  setLocation('/');
                }
              }}
              className="mb-4 hover:bg-accent -ml-4 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {showEditor ? 'Back to Campaigns' : 'Back to Dashboard'}
            </Button>
            <h1 className="text-2xl font-bold tracking-tight flex items-center">
              <Megaphone className="w-6 h-6 mr-3 text-primary" />
              Campaign Manager
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">Create and manage bulk messaging campaigns with AI-generated variations</p>
          </div>
          {!showEditor && (
            <Button onClick={() => setCreatingNew(true)} className="flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Campaign
            </Button>
          )}
        </div>

        {showEditor ? (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <CampaignMessageVariationPanel
              campaignId={selectedCampaignId || undefined}
              supabaseUrl={supabaseUrl}
              supabaseAnonKey={supabaseAnonKey}
              edgeFunctionUrl={edgeFunctionUrl}
              onCampaignCreated={handleCampaignCreated}
            />
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-3">
            {isLoading ? (
              <p className="text-center text-muted-foreground py-12">Loading campaigns...</p>
            ) : campaigns.length === 0 ? (
              <div className="text-center py-16 border-2 border-dashed border-border rounded-xl">
                <Megaphone className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
                <p className="text-muted-foreground mb-4">No campaigns yet. Create your first one!</p>
                <Button onClick={() => setCreatingNew(true)}><Plus className="w-4 h-4 mr-2" />New Campaign</Button>
              </div>
            ) : (
              campaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedCampaignId(c.id)}
                  className="w-full text-left flex items-center justify-between p-4 rounded-xl border border-border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{c.originalMessage}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <Badge variant="secondary" className="flex items-center gap-1">
                      <Users className="w-3 h-3" />{c.totalContacts}
                    </Badge>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
