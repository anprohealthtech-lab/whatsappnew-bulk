import { useQuery } from "@tanstack/react-query";
import { Database, FileText, Users, ClipboardList } from "lucide-react";

type DataSummary = {
  patients: number;
  documents: number;
  generalRecords: number;
  recentDocuments: Array<{
    id: string;
    fileName: string | null;
    documentType: string;
    status: string;
    confidence: number | null;
    createdAt: string | null;
  }>;
};

export function DataManagementPanel() {
  const { data, isLoading } = useQuery<DataSummary>({
    queryKey: ["/api/data-management/summary"],
    refetchInterval: 30000,
  });

  const stats = [
    { label: "Patients", value: data?.patients || 0, icon: Users },
    { label: "Documents", value: data?.documents || 0, icon: FileText },
    { label: "General Records", value: data?.generalRecords || 0, icon: ClipboardList },
  ];

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div>
        <h2 className="text-2xl font-bold">Data Management</h2>
        <p className="text-muted-foreground">Patient memory, parsed documents, and clinic data captured from WhatsApp.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.map((item) => (
          <div key={item.label} className="p-4 bg-card rounded-xl border flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <item.icon className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{isLoading ? "-" : item.value}</p>
              <p className="text-sm text-muted-foreground">{item.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-card rounded-xl border overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Recent Parsed Documents</h3>
        </div>
        <div className="divide-y">
          {isLoading ? (
            <p className="p-5 text-sm text-muted-foreground">Loading data records...</p>
          ) : data?.recentDocuments?.length ? (
            data.recentDocuments.map((doc) => (
              <div key={doc.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium truncate">{doc.fileName || doc.documentType || "WhatsApp document"}</p>
                  <p className="text-xs text-muted-foreground">
                    {doc.documentType} · {doc.status} · {doc.createdAt ? new Date(doc.createdAt).toLocaleString() : ""}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {typeof doc.confidence === "number" ? `${Math.round(doc.confidence * 100)}%` : ""}
                </span>
              </div>
            ))
          ) : (
            <p className="p-5 text-sm text-muted-foreground">No parsed documents yet. Send a report image or PDF to the connected WhatsApp number.</p>
          )}
        </div>
      </div>
    </div>
  );
}
