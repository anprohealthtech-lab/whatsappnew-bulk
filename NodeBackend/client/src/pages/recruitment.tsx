import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {useLocation} from 'wouter';
import {useAuth} from '@/lib/AuthContext';
import {apiRequest} from '@/lib/queryClient';
import {Button} from '@/components/ui/button';

type Candidate={id:string;name:string;phone:string;position:string;status:string;cv_count:number;answers:Record<string,string>;awaiting_field?:string};
export default function Recruitment(){
 const [,navigate]=useLocation();const {user}=useAuth();const [owner,setOwner]=useState('');const [error,setError]=useState('');
 const admin=user?.role==='super_admin';const scope=owner?'?userId='+encodeURIComponent(owner):'';
 const {data:users=[]}=useQuery<any[]>({queryKey:['/api/admin/users'],enabled:admin});
 const {data:rows=[],error:loadError}=useQuery<Candidate[]>({queryKey:['/api/recruitment/candidates'+scope],refetchInterval:15000});
 async function download(url:string,name:string){try{setError('');const r=await apiRequest('GET',url);const link=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=link;a.download=name;a.click();URL.revokeObjectURL(link);}catch(e){setError(e instanceof Error?e.message:'Download failed');}}
 async function cv(c:Candidate){try{const files=await (await apiRequest('GET',`/api/recruitment/candidates/${c.id}/files${scope}`)).json();for(const f of files)await download(`/api/recruitment/files/${f.id}${scope}`,f.file_name);}catch(e){setError(String(e));}}
 return <main className="min-h-screen bg-background text-foreground overflow-auto"><div className="max-w-7xl mx-auto p-6 space-y-6">
  <Button variant="ghost" onClick={()=>navigate('/')}>Back to dashboard</Button>
  <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-bold">Recruitment</h1><p className="text-muted-foreground mt-2">Latest CVs and applicant responses</p></div><Button onClick={()=>download('/api/recruitment/report.csv'+scope,'recruitment-report.csv')}>Export CSV</Button></div>
  {admin&&<label className="block">Account<select aria-label="Account" className="block border rounded p-2 mt-2 bg-background" value={owner} onChange={e=>setOwner(e.target.value)}><option value="">My account</option>{users.filter(u=>u.id!==user?.id).map(u=><option key={u.id} value={u.id}>{u.username}</option>)}</select></label>}
  {(error||loadError)&&<p role="alert" className="text-destructive">{error||String(loadError)}</p>}
  <p>{rows.length} applicants · {rows.filter(c=>c.status==='complete').length} profiles complete · {rows.filter(c=>c.cv_count>0).length} CVs received</p>
  <div className="overflow-x-auto border rounded-lg"><table className="w-full text-sm text-left"><thead className="bg-muted"><tr>{['Applicant','Status','Current organisation','Current CTC','Expected CTC','Residence','CV'].map(h=><th key={h} className="p-3 whitespace-nowrap">{h}</th>)}</tr></thead><tbody>
   {rows.map(c=><tr key={c.id} className="border-t"><td className="p-3 min-w-48"><b>{c.name}</b><div>{c.phone}</div></td><td className="p-3">{c.status.replaceAll('_',' ')}{c.awaiting_field&&<div className="text-muted-foreground">Awaiting {c.awaiting_field.replaceAll('_',' ')}</div>}</td>{['current_organisation','current_ctc','expected_ctc','residence'].map(k=><td key={k} className="p-3 min-w-32">{c.answers?.[k]||'—'}</td>)}<td className="p-3">{c.cv_count>0?<Button variant="outline" size="sm" onClick={()=>cv(c)}>Download ({c.cv_count})</Button>:'Awaiting CV'}</td></tr>)}
   {!rows.length&&<tr><td colSpan={7} className="p-6 text-muted-foreground">No applicants enrolled for this account.</td></tr>}
  </tbody></table></div>
 </div></main>;
}
