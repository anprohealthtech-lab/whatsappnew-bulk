import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ClipboardList, Database, FileText, UserRound, Users } from "lucide-react";

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
  patientList: Array<{
    id: string;
    canonicalName: string;
    age: number | null;
    gender: string | null;
    phoneNumbers: unknown;
    summary: string | null;
    metadata: unknown;
    lastUpdatedAt: string | null;
    createdAt: string | null;
  }>;
  generalRecordList: Array<{
    id: string;
    recordType: string;
    title: string;
    periodStart: string | null;
    periodEnd: string | null;
    rawText: string | null;
    structuredData: unknown;
    confidence: number | null;
    createdAt: string | null;
  }>;
  recentEvents: Array<{
    id: string;
    patientId: string;
    documentId: string | null;
    eventType: string;
    eventDate: string | null;
    summary: string;
    structuredData: unknown;
    createdAt: string | null;
  }>;
};

export function DataManagementPanel() {
  const [activeTab, setActiveTab] = useState<"patients" | "documents" | "general">("patients");
  const { data, isLoading } = useQuery<DataSummary>({
    queryKey: ["/api/data-management/summary"],
    refetchInterval: 30000,
  });

  const eventsByPatient = useMemo(() => {
    const map = new Map<string, DataSummary["recentEvents"]>();
    for (const event of data?.recentEvents || []) {
      const list = map.get(event.patientId) || [];
      list.push(event);
      map.set(event.patientId, list);
    }
    return map;
  }, [data?.recentEvents]);

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

      <div className="flex flex-wrap gap-2">
        {[
          { id: "patients", label: "Patients", icon: UserRound },
          { id: "documents", label: "Documents", icon: FileText },
          { id: "general", label: "General Records", icon: ClipboardList },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card hover:bg-accent"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "patients" && (
        <div className="bg-card rounded-xl border overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">Saved Patients</h3>
          </div>
          <div className="divide-y">
            {isLoading ? (
              <p className="p-5 text-sm text-muted-foreground">Loading patients...</p>
            ) : data?.patientList?.length ? (
              data.patientList.map((patient) => {
                const events = eventsByPatient.get(patient.id) || [];
                const phones = Array.isArray(patient.phoneNumbers) ? patient.phoneNumbers.join(", ") : "";
                return (
                  <div key={patient.id} className="p-5 space-y-3">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                      <div>
                        <p className="font-semibold text-lg">{patient.canonicalName}</p>
                        <p className="text-sm text-muted-foreground">
                          {[patient.age ? `${patient.age} yrs` : "", patient.gender || "", phones].filter(Boolean).join(" · ") || "No demographics extracted"}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Updated {patient.lastUpdatedAt ? new Date(patient.lastUpdatedAt).toLocaleString() : "-"}
                      </span>
                    </div>
                    {patient.summary && (
                      <p className="text-sm bg-accent/30 rounded-lg px-3 py-2">{patient.summary}</p>
                    )}
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <CalendarClock className="w-3 h-3" /> Recent Timeline
                      </p>
                      {events.length ? (
                        events.slice(0, 3).map((event) => (
                          <div key={event.id} className="text-sm border rounded-lg px-3 py-2">
                            <p className="font-medium">{event.summary}</p>
                            <p className="text-xs text-muted-foreground">
                              {event.eventType} · {event.eventDate || (event.createdAt ? new Date(event.createdAt).toLocaleDateString() : "")}
                            </p>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">No timeline events saved yet.</p>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="p-5 text-sm text-muted-foreground">No patients yet. Send a patient report image/PDF with patient name visible.</p>
            )}
          </div>
        </div>
      )}

      {activeTab === "general" && (
        <div className="bg-card rounded-xl border overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">General Data Records</h3>
          </div>
          <div className="divide-y">
            {isLoading ? (
              <p className="p-5 text-sm text-muted-foreground">Loading general records...</p>
            ) : data?.generalRecordList?.length ? (
              data.generalRecordList.map((record) => (
                <div key={record.id} className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold">{record.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {record.recordType} · {record.createdAt ? new Date(record.createdAt).toLocaleString() : ""}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {typeof record.confidence === "number" ? `${Math.round(record.confidence * 100)}%` : ""}
                    </span>
                  </div>
                  {record.rawText && <p className="text-sm mt-3 bg-accent/30 rounded-lg px-3 py-2">{record.rawText}</p>}
                  {record.structuredData && Object.keys(record.structuredData as Record<string, unknown>).length > 0 && (
                    <pre className="text-xs mt-3 overflow-auto bg-muted rounded-lg p-3">
                      {JSON.stringify(record.structuredData, null, 2)}
                    </pre>
                  )}
                </div>
              ))
            ) : (
              <p className="p-5 text-sm text-muted-foreground">No general records yet.</p>
            )}
          </div>
        </div>
      )}

      {activeTab === "documents" && (
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
      )}
    </div>
  );
}
