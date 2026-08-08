import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CalendarClock, ClipboardList, Database, Edit3, FileText, FolderTree, Loader2, Plus, RefreshCw, Search, TableProperties, Upload, UserRound, Users, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { getAuthToken } from "@/lib/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
    ocrText?: string | null;
    extractedJson?: unknown;
    createdAt: string | null;
  }>;
  patientList: Array<{
    id: string;
    canonicalName: string;
    age: number | null;
    gender: string | null;
    phoneNumbers: unknown;
    dob?: string | null;
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

type IndexedDocument = {
  id: string;
  patientId: string | null;
  patientName: string | null;
  fileName: string | null;
  caption: string | null;
  documentType: string;
  status: string;
  confidence: number | null;
  indexLevel1: string | null;
  indexLevel2: string | null;
  indexLevel3: string | null;
  indexPath: string | null;
  indexModality: string | null;
  indexLabels: unknown;
  indexConfidence: number | null;
  indexSource: string | null;
  ocrText?: string | null;
  extractedJson?: unknown;
  createdAt: string | null;
};

type DocumentSearchResult = {
  total: number;
  limit: number;
  offset: number;
  documents: IndexedDocument[];
};

type IndexTree = {
  tree: Array<{
    level1: string;
    count: number;
    children: Array<{
      level2: string;
      count: number;
      children: Array<{ level3: string; count: number }>;
    }>;
  }>;
  modalities: Array<{ modality: string; count: number }>;
  unindexedCount: number;
};

const DOCUMENT_PAGE_SIZE = 25;

/** "post_knee_replacement" reads better as "Post knee replacement" in the UI. */
function humanizeIndexTerm(value: string | null | undefined) {
  if (!value) return "";
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatIndexPath(document: Pick<IndexedDocument, "indexLevel1" | "indexLevel2" | "indexLevel3">) {
  return [document.indexLevel1, document.indexLevel2, document.indexLevel3]
    .filter(Boolean)
    .map((level) => humanizeIndexTerm(level))
    .join(" › ");
}

type PatientAnalysis = {
  patient: DataSummary["patientList"][number];
  events: DataSummary["recentEvents"];
  caseBatches: Array<{
    id: string;
    patientNameHint: string;
    status: string;
    expectedAttachmentCount: number | null;
    receivedAttachmentCount: number;
    eventDate: string | null;
    summary: string | null;
    errorMessage: string | null;
    createdAt: string | null;
    completedAt: string | null;
  }>;
  documents: Array<{
    id: string;
    documentType: string;
    fileName: string | null;
    status: string;
    confidence: number | null;
    createdAt: string | null;
  }>;
};

type Observation = {
  category?: string;
  name?: string;
  value?: string | null;
  numeric_value?: number | null;
  unit?: string | null;
  reference_range?: string | null;
  flag?: string | null;
  needs_confirmation?: boolean;
};

type StructuredClinicalData = {
  chief_complaint?: string | null;
  doctor_notes?: string | null;
  follow_up?: string | null;
  follow_up_date?: string | null;
  history?: unknown[];
  advice?: unknown[];
  warnings?: unknown[];
  physical_examination?: Array<Record<string, unknown>>;
  diagnoses?: Array<Record<string, unknown>>;
  tests_ordered?: Array<Record<string, unknown>>;
  prescriptions?: Array<Record<string, unknown>>;
  imaging_analysis?: Record<string, unknown> | null;
};

function formatRecordItems(items: unknown, keys: string[]) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    return keys.map((key) => String(record[key] || "").trim()).filter(Boolean).join(" | ");
  }).filter(Boolean);
}

function ClinicalEventDetails({ structuredData }: { structuredData: unknown }) {
  const clinical = structuredData && typeof structuredData === "object"
    ? structuredData as StructuredClinicalData
    : {};
  const imaging = clinical.imaging_analysis && typeof clinical.imaging_analysis === "object"
    ? clinical.imaging_analysis
    : {};
  const imagingSummary = [
    ["Type", imaging.analysis_type],
    ["Modality", imaging.modality],
    ["Body part", imaging.body_part],
    ["Laterality", imaging.laterality],
    ["View", imaging.view],
    ["Image quality", imaging.image_quality],
    ["Impression", imaging.impression],
    ["Comparison", imaging.comparison],
  ].filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${String(value)}`);
  imagingSummary.push(...formatRecordItems(imaging.findings, ["finding", "location"]));
  imagingSummary.push(...formatRecordItems(imaging.limitations, []).map((value) => `Limitation: ${value}`));
  imagingSummary.push(...formatRecordItems(imaging.urgent_findings, []).map((value) => `Urgent finding: ${value}`));

  const sections = [
    { label: "Chief complaint", values: clinical.chief_complaint ? [clinical.chief_complaint] : [] },
    { label: "Doctor notes", values: clinical.doctor_notes ? [clinical.doctor_notes] : [] },
    { label: "History", values: formatRecordItems(clinical.history, []) },
    { label: "Physical examination", values: formatRecordItems(clinical.physical_examination, ["system", "finding"]) },
    { label: "Diagnoses", values: formatRecordItems(clinical.diagnoses, ["name", "notes"]) },
    { label: "Tests ordered", values: formatRecordItems(clinical.tests_ordered, ["name", "type", "instructions"]) },
    { label: "Prescriptions", values: formatRecordItems(clinical.prescriptions, ["medicine", "dosage", "frequency", "duration", "instructions"]) },
    { label: "Advice", values: formatRecordItems(clinical.advice, []) },
    { label: "Follow-up", values: clinical.follow_up ? [clinical.follow_up] : [] },
    { label: "Follow-up date", values: clinical.follow_up_date ? [clinical.follow_up_date] : [] },
    { label: "Imaging analysis (preliminary)", values: imagingSummary },
    { label: "Warnings", values: formatRecordItems(clinical.warnings, []) },
  ].filter((section) => section.values.length);

  if (!sections.length) return null;

  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer font-medium text-primary">View extracted clinical note</summary>
      <div className="mt-2 space-y-2 rounded-lg bg-muted/30 p-3">
        {sections.map((section) => (
          <div key={section.label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.label}</p>
            {section.values.map((value, index) => (
              <p key={`${section.label}-${index}`} className="whitespace-pre-wrap">{value}</p>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

export function DataManagementPanel() {
  const [activeTab, setActiveTab] = useState<"patients" | "documents" | "general">("patients");
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [patientDialogOpen, setPatientDialogOpen] = useState(false);
  const [editingPatientId, setEditingPatientId] = useState<string | null>(null);
  const [patientForm, setPatientForm] = useState({
    canonicalName: "",
    age: "",
    gender: "",
    phoneNumbers: "",
    dob: "",
    summary: "",
  });
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadPatientId, setUploadPatientId] = useState("");
  const [uploadEventDate, setUploadEventDate] = useState("");
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [editingEvent, setEditingEvent] = useState<DataSummary["recentEvents"][number] | null>(null);
  const [eventForm, setEventForm] = useState({ eventDate: "", eventType: "", summary: "", structuredData: "{}" });
  const [editingDocument, setEditingDocument] = useState<IndexedDocument | null>(null);
  const [documentForm, setDocumentForm] = useState({
    documentType: "",
    status: "",
    ocrText: "",
    extractedJson: "{}",
    indexLevel1: "",
    indexLevel2: "",
    indexLevel3: "",
    indexModality: "",
    indexLabels: "",
  });
  const [docFilters, setDocFilters] = useState({
    q: "",
    level1: "",
    level2: "",
    level3: "",
    modality: "",
    status: "",
    patientId: "",
  });
  const [docSearch, setDocSearch] = useState("");
  const [docOffset, setDocOffset] = useState(0);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<DataSummary>({
    queryKey: ["/api/data-management/summary"],
    refetchInterval: 30000,
  });
  const { data: patientAnalysis, isLoading: isAnalysisLoading } = useQuery<PatientAnalysis>({
    queryKey: [`/api/data-management/patients/${selectedPatientId}/analysis`],
    enabled: Boolean(selectedPatientId),
  });

  const { data: indexTree } = useQuery<IndexTree>({
    queryKey: ["/api/data-management/index-tree"],
    enabled: activeTab === "documents",
  });

  // Typing in the search box should not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDocFilters((current) => (current.q === docSearch ? current : { ...current, q: docSearch }));
      setDocOffset(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [docSearch]);

  const documentsUrl = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(docFilters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    params.set("limit", String(DOCUMENT_PAGE_SIZE));
    params.set("offset", String(docOffset));
    return `/api/data-management/documents?${params.toString()}`;
  }, [docFilters, docOffset]);

  const { data: documentSearch, isLoading: isDocumentsLoading } = useQuery<DocumentSearchResult>({
    queryKey: [documentsUrl],
    enabled: activeTab === "documents",
  });

  const refreshData = async (patientId?: string | null) => {
    await queryClient.invalidateQueries({ queryKey: ["/api/data-management/summary"] });
    await queryClient.invalidateQueries({
      predicate: (query) => String(query.queryKey[0] || "").startsWith("/api/data-management/documents"),
    });
    await queryClient.invalidateQueries({ queryKey: ["/api/data-management/index-tree"] });
    if (patientId) {
      await queryClient.invalidateQueries({ queryKey: [`/api/data-management/patients/${patientId}/analysis`] });
    }
  };

  const patientMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        canonicalName: patientForm.canonicalName.trim(),
        age: patientForm.age ? Number(patientForm.age) : null,
        gender: patientForm.gender.trim() || null,
        phoneNumbers: patientForm.phoneNumbers.split(",").map((value) => value.trim()).filter(Boolean),
        dob: patientForm.dob || null,
        summary: patientForm.summary.trim() || null,
      };
      const response = await apiRequest(
        editingPatientId ? "PATCH" : "POST",
        editingPatientId ? `/api/data-management/patients/${editingPatientId}` : "/api/data-management/patients",
        payload,
      );
      return response.json();
    },
    onSuccess: async (patient) => {
      await refreshData(patient.id);
      setPatientDialogOpen(false);
      setEditingPatientId(null);
      toast({ title: "Patient saved" });
    },
    onError: (error: any) => toast({ title: "Could not save patient", description: error.message, variant: "destructive" }),
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!uploadPatientId) throw new Error("Select a patient");
      if (!uploadFiles.length) throw new Error("Select at least one image or PDF");
      const formData = new FormData();
      uploadFiles.forEach((file) => formData.append("files", file));
      if (uploadEventDate) formData.append("eventDate", uploadEventDate);
      if (uploadCaption.trim()) formData.append("caption", uploadCaption.trim());
      const response = await fetch(`/api/data-management/patients/${uploadPatientId}/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAuthToken() || ""}` },
        body: formData,
        credentials: "include",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || "Upload failed");
      return body;
    },
    onSuccess: async (result) => {
      await refreshData(uploadPatientId);
      setSelectedPatientId(uploadPatientId);
      setUploadDialogOpen(false);
      setUploadFiles([]);
      setUploadCaption("");
      setUploadEventDate("");
      toast({
        title: `${result.uploadedCount} document(s) uploaded`,
        description: "AI parsing is running in the background. The patient timeline will update automatically.",
      });
    },
    onError: (error: any) => toast({ title: "Document upload failed", description: error.message, variant: "destructive" }),
  });

  const eventMutation = useMutation({
    mutationFn: async () => {
      if (!editingEvent) throw new Error("No visit selected");
      let structuredData: Record<string, unknown>;
      try {
        structuredData = JSON.parse(eventForm.structuredData);
      } catch {
        throw new Error("Extracted clinical data must be valid JSON");
      }
      const response = await apiRequest("PATCH", `/api/data-management/events/${editingEvent.id}`, {
        eventDate: eventForm.eventDate || null,
        eventType: eventForm.eventType.trim(),
        summary: eventForm.summary.trim(),
        structuredData,
      });
      return response.json();
    },
    onSuccess: async (event) => {
      await refreshData(event.patientId);
      setEditingEvent(null);
      toast({ title: "Visit updated" });
    },
    onError: (error: any) => toast({ title: "Could not update visit", description: error.message, variant: "destructive" }),
  });

  const documentMutation = useMutation({
    mutationFn: async () => {
      if (!editingDocument) throw new Error("No document selected");
      let extractedJson: Record<string, unknown>;
      try {
        extractedJson = JSON.parse(documentForm.extractedJson);
      } catch {
        throw new Error("Extracted document data must be valid JSON");
      }
      const response = await apiRequest("PATCH", `/api/data-management/documents/${editingDocument.id}`, {
        documentType: documentForm.documentType.trim(),
        status: documentForm.status,
        ocrText: documentForm.ocrText || null,
        extractedJson,
        indexLevel1: documentForm.indexLevel1.trim() || null,
        indexLevel2: documentForm.indexLevel2.trim() || null,
        indexLevel3: documentForm.indexLevel3.trim() || null,
        indexModality: documentForm.indexModality.trim() || null,
        indexLabels: documentForm.indexLabels.split(",").map((label) => label.trim()).filter(Boolean),
      });
      return response.json();
    },
    onSuccess: async () => {
      await refreshData(selectedPatientId);
      setEditingDocument(null);
      toast({ title: "Document updated" });
    },
    onError: (error: any) => toast({ title: "Could not update document", description: error.message, variant: "destructive" }),
  });

  const reindexMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/data-management/reindex", { limit: 25 });
      return response.json() as Promise<{ scanned: number; indexed: number; skipped: number }>;
    },
    onSuccess: async (result) => {
      await refreshData(selectedPatientId);
      toast({
        title: `Indexed ${result.indexed} of ${result.scanned} document(s)`,
        description: result.skipped
          ? `${result.skipped} could not be classified from the saved text. Run again to continue through the backlog.`
          : "Run again to continue through the backlog.",
      });
    },
    onError: (error: any) => toast({ title: "Reindex failed", description: error.message, variant: "destructive" }),
  });

  const openCreatePatient = () => {
    setEditingPatientId(null);
    setPatientForm({ canonicalName: "", age: "", gender: "", phoneNumbers: "", dob: "", summary: "" });
    setPatientDialogOpen(true);
  };

  const openEditPatient = (patient: DataSummary["patientList"][number]) => {
    setEditingPatientId(patient.id);
    setPatientForm({
      canonicalName: patient.canonicalName,
      age: patient.age == null ? "" : String(patient.age),
      gender: patient.gender || "",
      phoneNumbers: Array.isArray(patient.phoneNumbers) ? patient.phoneNumbers.join(", ") : "",
      dob: String((patient as any).dob || ""),
      summary: patient.summary || "",
    });
    setPatientDialogOpen(true);
  };

  const openUpload = (patientId = selectedPatientId || data?.patientList?.[0]?.id || "") => {
    setUploadPatientId(patientId);
    setUploadFiles([]);
    setUploadDialogOpen(true);
  };

  const openEditEvent = (event: DataSummary["recentEvents"][number]) => {
    setEditingEvent(event);
    setEventForm({
      eventDate: event.eventDate || "",
      eventType: event.eventType,
      summary: event.summary,
      structuredData: JSON.stringify(event.structuredData || {}, null, 2),
    });
  };

  const openEditDocument = (document: IndexedDocument) => {
    setEditingDocument(document);
    setDocumentForm({
      documentType: document.documentType,
      status: document.status,
      ocrText: document.ocrText || "",
      extractedJson: JSON.stringify(document.extractedJson || {}, null, 2),
      indexLevel1: document.indexLevel1 || "",
      indexLevel2: document.indexLevel2 || "",
      indexLevel3: document.indexLevel3 || "",
      indexModality: document.indexModality || "",
      indexLabels: Array.isArray(document.indexLabels) ? document.indexLabels.join(", ") : "",
    });
  };

  // Selecting a level clears the levels below it, so the drill-down stays valid.
  const applyIndexFilter = (patch: Partial<typeof docFilters>) => {
    setDocFilters((current) => {
      const next = { ...current, ...patch };
      if (patch.level1 !== undefined) {
        next.level2 = patch.level2 ?? "";
        next.level3 = patch.level3 ?? "";
      } else if (patch.level2 !== undefined) {
        next.level3 = patch.level3 ?? "";
      }
      return next;
    });
    setDocOffset(0);
  };

  const clearIndexFilters = () => {
    setDocSearch("");
    setDocFilters({ q: "", level1: "", level2: "", level3: "", modality: "", status: "", patientId: "" });
    setDocOffset(0);
  };

  const level1Options = indexTree?.tree || [];
  const level2Options = level1Options.find((node) => node.level1 === docFilters.level1)?.children || [];
  const level3Options = level2Options.find((node) => node.level2 === docFilters.level2)?.children || [];
  const hasActiveDocFilters = Object.values(docFilters).some(Boolean);

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

  const horizontalAnalysis = useMemo(() => {
    const dates: string[] = [];
    const rows = new Map<string, { category: string; name: string; values: Map<string, Observation[]> }>();

    for (const event of [...(patientAnalysis?.events || [])].reverse()) {
      const eventDate = event.eventDate || (event.createdAt ? new Date(event.createdAt).toISOString().slice(0, 10) : "Unknown date");
      if (!dates.includes(eventDate)) dates.push(eventDate);
      const structured = event.structuredData && typeof event.structuredData === "object"
        ? event.structuredData as Record<string, unknown>
        : {};
      const observations = Array.isArray(structured.observations)
        ? structured.observations.filter((item): item is Observation => Boolean(item) && typeof item === "object")
        : [];

      for (const observation of observations) {
        const name = String(observation.name || "").trim();
        if (!name) continue;
        const category = String(observation.category || "other");
        const key = `${category}:${name.toLowerCase()}`;
        const row = rows.get(key) || { category, name, values: new Map<string, Observation[]>() };
        const values = row.values.get(eventDate) || [];
        values.push(observation);
        row.values.set(eventDate, values);
        rows.set(key, row);
      }
    }

    return { dates, rows: Array.from(rows.values()) };
  }, [patientAnalysis?.events]);

  const formatObservation = (observation: Observation) => {
    const value = observation.value || (typeof observation.numeric_value === "number" ? String(observation.numeric_value) : "-");
    const unit = observation.unit?.trim();
    const alreadyHasUnit = unit && value.toLowerCase().endsWith(unit.toLowerCase());
    return `${value}${unit && !alreadyHasUnit ? ` ${unit}` : ""}`;
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-2xl font-bold">Data Management</h2>
          <p className="text-muted-foreground">Create patients, upload records, and review data captured from the app or WhatsApp.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={openCreatePatient}>
            <Plus className="mr-2 h-4 w-4" /> Create Patient
          </Button>
          <Button onClick={() => openUpload()} disabled={!data?.patientList?.length}>
            <Upload className="mr-2 h-4 w-4" /> Upload Documents
          </Button>
        </div>
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
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEditPatient(patient)}>
                          <Edit3 className="mr-1 h-3.5 w-3.5" /> Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openUpload(patient.id)}>
                          <Upload className="mr-1 h-3.5 w-3.5" /> Upload
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Updated {patient.lastUpdatedAt ? new Date(patient.lastUpdatedAt).toLocaleString() : "-"}
                        </span>
                      </div>
                    </div>
                    {patient.summary && (
                      <p className="text-sm bg-accent/30 rounded-lg px-3 py-2">{patient.summary}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedPatientId(selectedPatientId === patient.id ? null : patient.id)}
                      className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                    >
                      <Activity className="w-4 h-4" />
                      {selectedPatientId === patient.id ? "Close patient analysis" : "Open vertical and horizontal analysis"}
                    </button>
                    {selectedPatientId === patient.id && (
                      <div className="space-y-4 rounded-xl border bg-background p-4">
                        {isAnalysisLoading ? (
                          <p className="text-sm text-muted-foreground">Loading complete patient history...</p>
                        ) : (
                          <>
                            <div>
                              {patientAnalysis?.caseBatches?.length ? (
                                <div className="mb-4">
                                  <p className="mb-2 text-sm font-semibold">Multi-attachment cases</p>
                                  <div className="space-y-2">
                                    {patientAnalysis.caseBatches.map((batch) => (
                                      <div key={batch.id} className="rounded-lg border px-3 py-2 text-sm">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <p className="font-medium">
                                            {batch.receivedAttachmentCount}
                                            {batch.expectedAttachmentCount ? ` / ${batch.expectedAttachmentCount}` : ""} attachments
                                          </p>
                                          <span className={batch.status === "completed"
                                            ? "text-green-600"
                                            : batch.status === "failed" || batch.status === "needs_review"
                                              ? "text-destructive"
                                              : "text-muted-foreground"}
                                          >
                                            {batch.status.replace(/_/g, " ")}
                                          </span>
                                        </div>
                                        {(batch.eventDate || batch.createdAt) && (
                                          <p className="text-xs text-muted-foreground">
                                            {batch.eventDate || (batch.createdAt ? new Date(batch.createdAt).toLocaleString() : "")}
                                          </p>
                                        )}
                                        {batch.errorMessage && <p className="mt-1 text-xs text-destructive">{batch.errorMessage}</p>}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
                                <CalendarClock className="w-4 h-4 text-primary" /> Vertical patient timeline
                              </p>
                              <div className="space-y-2">
                                {patientAnalysis?.events?.length ? patientAnalysis.events.map((event) => (
                                  <div key={event.id} className="border-l-2 border-primary/40 pl-3 py-1">
                                    <div className="flex items-start justify-between gap-3">
                                      <p className="text-sm font-medium">{event.summary}</p>
                                      <Button size="sm" variant="ghost" onClick={() => openEditEvent(event)}>
                                        <Edit3 className="mr-1 h-3.5 w-3.5" /> Edit visit
                                      </Button>
                                    </div>
                                    <ClinicalEventDetails structuredData={event.structuredData} />
                                    <p className="text-xs text-muted-foreground">
                                      {event.eventDate || (event.createdAt ? new Date(event.createdAt).toLocaleDateString() : "Unknown date")} · {event.eventType}
                                    </p>
                                  </div>
                                )) : (
                                  <p className="text-sm text-muted-foreground">No patient timeline is available.</p>
                                )}
                              </div>
                            </div>

                            <div>
                              <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
                                <TableProperties className="w-4 h-4 text-primary" /> Horizontal clinical comparison
                              </p>
                              {horizontalAnalysis.rows.length ? (
                                <div className="overflow-x-auto rounded-lg border">
                                  <table className="min-w-full text-sm">
                                    <thead className="bg-muted/60">
                                      <tr>
                                        <th className="sticky left-0 bg-muted px-3 py-2 text-left font-medium">Clinical field</th>
                                        {horizontalAnalysis.dates.map((date) => (
                                          <th key={date} className="whitespace-nowrap px-3 py-2 text-left font-medium">{date}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                      {horizontalAnalysis.rows.map((row) => (
                                        <tr key={`${row.category}:${row.name}`}>
                                          <td className="sticky left-0 bg-background px-3 py-2">
                                            <p className="font-medium">{row.name}</p>
                                            <p className="text-xs text-muted-foreground">{row.category.replace(/_/g, " ")}</p>
                                          </td>
                                          {horizontalAnalysis.dates.map((date) => (
                                            <td key={date} className="min-w-36 px-3 py-2 align-top">
                                              {(row.values.get(date) || []).map((observation, index) => (
                                                <div
                                                  key={`${date}-${index}`}
                                                  className={observation.flag && observation.flag !== "normal" && observation.flag !== "unknown"
                                                    ? "font-medium text-destructive"
                                                    : ""}
                                                  title={observation.reference_range ? `Reference: ${observation.reference_range}` : undefined}
                                                >
                                                  {formatObservation(observation)}
                                                  {observation.flag && observation.flag !== "unknown" ? ` (${observation.flag})` : ""}
                                                  {observation.needs_confirmation ? " · verify" : ""}
                                                </div>
                                              ))}
                                            </td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  No standardized observations yet. New documents parsed with clinical-record-v2 will populate this comparison.
                                </p>
                              )}
                            </div>
                          </>
                        )}
                      </div>
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
                  {Boolean(record.structuredData) && Object.keys(record.structuredData as Record<string, unknown>).length > 0 && (
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
      <div className="space-y-4">
        <div className="bg-card rounded-xl border overflow-hidden">
          <div className="px-5 py-4 border-b flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FolderTree className="w-5 h-5 text-primary" />
              <h3 className="font-semibold">Subject Index</h3>
            </div>
            <div className="flex items-center gap-2">
              {indexTree?.unindexedCount ? (
                <span className="text-xs text-muted-foreground">{indexTree.unindexedCount} not indexed yet</span>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => reindexMutation.mutate()}
                disabled={reindexMutation.isPending || !indexTree?.unindexedCount}
                title="Classify older documents that were parsed before indexing existed"
              >
                {reindexMutation.isPending
                  ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                Index backlog
              </Button>
            </div>
          </div>

          <div className="p-5 space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="flex-1 space-y-1">
                <Label htmlFor="doc-search" className="text-xs text-muted-foreground">Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="doc-search"
                    className="pl-9"
                    value={docSearch}
                    onChange={(event) => setDocSearch(event.target.value)}
                    placeholder="File name, caption, index term, or text inside the report"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="doc-modality" className="text-xs text-muted-foreground">Type of study</Label>
                <select
                  id="doc-modality"
                  value={docFilters.modality}
                  onChange={(event) => applyIndexFilter({ modality: event.target.value })}
                  className="flex h-10 w-full min-w-[10rem] rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Any</option>
                  {(indexTree?.modalities || []).map((item) => (
                    <option key={item.modality} value={item.modality}>
                      {humanizeIndexTerm(item.modality)} ({item.count})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="doc-status" className="text-xs text-muted-foreground">Status</Label>
                <select
                  id="doc-status"
                  value={docFilters.status}
                  onChange={(event) => applyIndexFilter({ status: event.target.value })}
                  className="flex h-10 w-full min-w-[9rem] rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Any</option>
                  <option value="processed">Processed</option>
                  <option value="needs_review">Needs review</option>
                  <option value="pending">Pending</option>
                  <option value="failed">Failed</option>
                </select>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="doc-level1" className="text-xs text-muted-foreground">Region / domain</Label>
                <select
                  id="doc-level1"
                  value={docFilters.level1}
                  onChange={(event) => applyIndexFilter({ level1: event.target.value })}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">All</option>
                  {level1Options.map((node) => (
                    <option key={node.level1} value={node.level1}>
                      {humanizeIndexTerm(node.level1)} ({node.count})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="doc-level2" className="text-xs text-muted-foreground">Condition / procedure</Label>
                <select
                  id="doc-level2"
                  value={docFilters.level2}
                  onChange={(event) => applyIndexFilter({ level2: event.target.value })}
                  disabled={!docFilters.level1}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">All</option>
                  {level2Options.map((node) => (
                    <option key={node.level2} value={node.level2}>
                      {humanizeIndexTerm(node.level2)} ({node.count})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="doc-level3" className="text-xs text-muted-foreground">Stage</Label>
                <select
                  id="doc-level3"
                  value={docFilters.level3}
                  onChange={(event) => applyIndexFilter({ level3: event.target.value })}
                  disabled={!docFilters.level2}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">All</option>
                  {level3Options.map((node) => (
                    <option key={node.level3} value={node.level3}>
                      {humanizeIndexTerm(node.level3)} ({node.count})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {hasActiveDocFilters && (
              <div className="flex items-center justify-between gap-2 text-sm">
                <p className="text-muted-foreground">
                  {documentSearch?.total ?? 0} matching document{documentSearch?.total === 1 ? "" : "s"}
                </p>
                <Button size="sm" variant="ghost" onClick={clearIndexFilters}>
                  <X className="mr-1 h-3.5 w-3.5" /> Clear filters
                </Button>
              </div>
            )}

            {!level1Options.length && (
              <p className="text-sm text-muted-foreground">
                No subject index yet. New uploads are indexed automatically as the AI reads them; use "Index backlog" for documents parsed earlier.
              </p>
            )}
          </div>
        </div>

        <div className="bg-card rounded-xl border overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">Parsed Documents</h3>
          </div>
          <div className="divide-y">
            {isDocumentsLoading ? (
              <p className="p-5 text-sm text-muted-foreground">Loading data records...</p>
            ) : documentSearch?.documents?.length ? (
              documentSearch.documents.map((doc) => {
                const indexPath = formatIndexPath(doc);
                return (
                  <div key={doc.id} className="px-5 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium truncate">{doc.fileName || doc.documentType || "WhatsApp document"}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {indexPath ? (
                          <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            {indexPath}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            Not indexed
                          </span>
                        )}
                        {doc.indexModality && (
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                            {humanizeIndexTerm(doc.indexModality)}
                          </span>
                        )}
                        {doc.indexSource === "manual" && (
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                            Manually indexed
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {[
                          doc.patientName,
                          doc.documentType,
                          doc.status,
                          doc.createdAt ? new Date(doc.createdAt).toLocaleString() : "",
                        ].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {typeof doc.confidence === "number" ? `${Math.round(doc.confidence * 100)}%` : ""}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => openEditDocument(doc)}>
                        <Edit3 className="mr-1 h-3.5 w-3.5" /> Edit
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="p-5 text-sm text-muted-foreground">
                {hasActiveDocFilters
                  ? "No documents match these index filters."
                  : "No parsed documents yet. Send a report image or PDF to the connected WhatsApp number."}
              </p>
            )}
          </div>
          {(documentSearch?.total || 0) > DOCUMENT_PAGE_SIZE && (
            <div className="px-5 py-3 border-t flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {docOffset + 1}-{Math.min(docOffset + DOCUMENT_PAGE_SIZE, documentSearch?.total || 0)} of {documentSearch?.total || 0}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDocOffset((current) => Math.max(0, current - DOCUMENT_PAGE_SIZE))}
                  disabled={docOffset === 0}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDocOffset((current) => current + DOCUMENT_PAGE_SIZE)}
                  disabled={docOffset + DOCUMENT_PAGE_SIZE >= (documentSearch?.total || 0)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      <Dialog open={patientDialogOpen} onOpenChange={setPatientDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingPatientId ? "Edit Patient" : "Create Patient"}</DialogTitle>
            <DialogDescription>
              Patient details entered here become the trusted identity for documents uploaded from the app.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="patient-name">Patient name</Label>
              <Input
                id="patient-name"
                value={patientForm.canonicalName}
                onChange={(event) => setPatientForm((current) => ({ ...current, canonicalName: event.target.value }))}
                placeholder="Full patient name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-age">Age</Label>
              <Input
                id="patient-age"
                type="number"
                min="0"
                max="150"
                value={patientForm.age}
                onChange={(event) => setPatientForm((current) => ({ ...current, age: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-gender">Gender</Label>
              <Input
                id="patient-gender"
                value={patientForm.gender}
                onChange={(event) => setPatientForm((current) => ({ ...current, gender: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-dob">Date of birth</Label>
              <Input
                id="patient-dob"
                type="date"
                value={patientForm.dob}
                onChange={(event) => setPatientForm((current) => ({ ...current, dob: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-phone">Phone numbers</Label>
              <Input
                id="patient-phone"
                value={patientForm.phoneNumbers}
                onChange={(event) => setPatientForm((current) => ({ ...current, phoneNumbers: event.target.value }))}
                placeholder="Comma-separated"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="patient-summary">Patient summary</Label>
              <Textarea
                id="patient-summary"
                rows={4}
                value={patientForm.summary}
                onChange={(event) => setPatientForm((current) => ({ ...current, summary: event.target.value }))}
                placeholder="Important history or current summary"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPatientDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => patientMutation.mutate()}
              disabled={patientMutation.isPending || patientForm.canonicalName.trim().length < 2}
            >
              {patientMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Patient
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload Patient Documents</DialogTitle>
            <DialogDescription>
              Select up to 30 images or PDFs from one clinical visit. Each file is saved separately, then AI consolidates them into one timeline event.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="upload-patient">Patient</Label>
              <select
                id="upload-patient"
                value={uploadPatientId}
                onChange={(event) => setUploadPatientId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Select patient</option>
                {(data?.patientList || []).map((patient) => (
                  <option key={patient.id} value={patient.id}>{patient.canonicalName}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="upload-date">Visit/report date</Label>
              <Input
                id="upload-date"
                type="date"
                value={uploadEventDate}
                onChange={(event) => setUploadEventDate(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="upload-caption">Instructions or note</Label>
              <Textarea
                id="upload-caption"
                rows={3}
                value={uploadCaption}
                onChange={(event) => setUploadCaption(event.target.value)}
                placeholder="Example: All pages belong to the same neurosurgery visit"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-files">Images and PDFs</Label>
              <Input
                id="patient-files"
                type="file"
                multiple
                accept=".pdf,image/jpeg,image/png,image/webp,image/gif"
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  if (files.length > 30) {
                    toast({ title: "Too many files", description: "Select no more than 30 files.", variant: "destructive" });
                    event.target.value = "";
                    setUploadFiles([]);
                    return;
                  }
                  setUploadFiles(files);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {uploadFiles.length ? `${uploadFiles.length} file(s) selected` : "PDF, JPG, PNG, WEBP, or GIF. Maximum 10 MB per file."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => uploadMutation.mutate()}
              disabled={uploadMutation.isPending || !uploadPatientId || !uploadFiles.length}
            >
              {uploadMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Upload and Process
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingEvent)} onOpenChange={(open) => !open && setEditingEvent(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Patient Visit</DialogTitle>
            <DialogDescription>
              Correct the visible summary or any extracted clinical field. Keep the structured data as a valid JSON object.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="event-date">Event date</Label>
              <Input id="event-date" type="date" value={eventForm.eventDate} onChange={(event) => setEventForm((current) => ({ ...current, eventDate: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-type">Event type</Label>
              <Input id="event-type" value={eventForm.eventType} onChange={(event) => setEventForm((current) => ({ ...current, eventType: event.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="event-summary">Timeline summary</Label>
              <Textarea id="event-summary" rows={4} value={eventForm.summary} onChange={(event) => setEventForm((current) => ({ ...current, summary: event.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="event-json">Extracted clinical data (JSON)</Label>
              <Textarea
                id="event-json"
                rows={20}
                className="font-mono text-xs"
                value={eventForm.structuredData}
                onChange={(event) => setEventForm((current) => ({ ...current, structuredData: event.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingEvent(null)}>Cancel</Button>
            <Button onClick={() => eventMutation.mutate()} disabled={eventMutation.isPending || !eventForm.summary.trim()}>
              {eventMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Visit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingDocument)} onOpenChange={(open) => !open && setEditingDocument(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Parsed Document</DialogTitle>
            <DialogDescription>Correct document classification, OCR text, status, or the complete extracted JSON.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="document-type">Document type</Label>
              <Input id="document-type" value={documentForm.documentType} onChange={(event) => setDocumentForm((current) => ({ ...current, documentType: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="document-status">Status</Label>
              <select
                id="document-status"
                value={documentForm.status}
                onChange={(event) => setDocumentForm((current) => ({ ...current, status: event.target.value }))}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="pending">Pending</option>
                <option value="processed">Processed</option>
                <option value="needs_review">Needs review</option>
                <option value="failed">Failed</option>
              </select>
            </div>
            <div className="space-y-2 md:col-span-2 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <FolderTree className="h-4 w-4 text-primary" />
                <p className="text-sm font-medium">Subject index</p>
              </div>
              <p className="text-xs text-muted-foreground">
                Three levels from broad to specific, for example knee › knee_replacement › post_operative.
                Editing these marks the index as manually set so re-parsing will not overwrite it.
              </p>
              <div className="grid gap-3 md:grid-cols-3 pt-1">
                <div className="space-y-2">
                  <Label htmlFor="document-index1" className="text-xs">Level 1 — region / domain</Label>
                  <Input
                    id="document-index1"
                    value={documentForm.indexLevel1}
                    onChange={(event) => setDocumentForm((current) => ({ ...current, indexLevel1: event.target.value }))}
                    placeholder="knee"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="document-index2" className="text-xs">Level 2 — condition / procedure</Label>
                  <Input
                    id="document-index2"
                    value={documentForm.indexLevel2}
                    onChange={(event) => setDocumentForm((current) => ({ ...current, indexLevel2: event.target.value }))}
                    placeholder="knee_replacement"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="document-index3" className="text-xs">Level 3 — stage</Label>
                  <Input
                    id="document-index3"
                    value={documentForm.indexLevel3}
                    onChange={(event) => setDocumentForm((current) => ({ ...current, indexLevel3: event.target.value }))}
                    placeholder="post_operative"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="document-modality" className="text-xs">Type of study</Label>
                  <Input
                    id="document-modality"
                    value={documentForm.indexModality}
                    onChange={(event) => setDocumentForm((current) => ({ ...current, indexModality: event.target.value }))}
                    placeholder="xray"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="document-labels" className="text-xs">Search keywords</Label>
                  <Input
                    id="document-labels"
                    value={documentForm.indexLabels}
                    onChange={(event) => setDocumentForm((current) => ({ ...current, indexLabels: event.target.value }))}
                    placeholder="tkr, total_knee_replacement, arthroplasty"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="document-ocr">OCR/raw text</Label>
              <Textarea id="document-ocr" rows={8} value={documentForm.ocrText} onChange={(event) => setDocumentForm((current) => ({ ...current, ocrText: event.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="document-json">Extracted document data (JSON)</Label>
              <Textarea
                id="document-json"
                rows={16}
                className="font-mono text-xs"
                value={documentForm.extractedJson}
                onChange={(event) => setDocumentForm((current) => ({ ...current, extractedJson: event.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingDocument(null)}>Cancel</Button>
            <Button onClick={() => documentMutation.mutate()} disabled={documentMutation.isPending || !documentForm.documentType.trim()}>
              {documentMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
