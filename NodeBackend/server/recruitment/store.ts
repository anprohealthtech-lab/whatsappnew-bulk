import {randomUUID} from 'node:crypto';
import type {CloudDatabase, Row, Tenant} from '../cloud/model';

export const questions: Record<string,string> = {
 cv: 'Please attach your latest CV here as a PDF, Word document or clear photo. If you need time, reply "send later" and we can collect the other details first.',
 current_organisation: 'What is your current organisation? If you are not working, please say "not currently working".',
 current_ctc: 'What is your current CTC? Please include the currency and whether the amount is monthly or annual. You may reply "prefer not to share".',
 expected_ctc: 'What is your expected CTC? Please include the currency and whether the amount is monthly or annual. You may reply "prefer not to share".',
 residence: 'Which area and city do you currently live in? Your full home address is not needed.',
 residence_city: 'Which area and city do you currently live in? Your full home address is not needed.',
 residence_area: 'Which area or locality do you currently live in? Your full home address is not needed.',
};
const order=['current_organisation','current_ctc','expected_ctc','residence_city','residence_area'];
export const MAX_QUESTION_ASKS=3; // Initial question plus at most two repeats.
export const isHumanRequest=(text:string)=>/^(human|person|recruiter|call me|speak to someone|talk to someone)[.!\s]*$/i.test(text)||/\b(?:can|may|could)\s+i\s+(?:call|speak|talk)\b/i.test(text);
export function questionInReply(reply:string):string|undefined {
 if(/Which area or locality/.test(reply))return 'residence_area';
 for(const key of order)if(reply.includes(questions[key]))return key;
 if(/attach your latest CV/i.test(reply))return 'cv';
}
const stateOnly=/^(?:gujarat|maharashtra|rajasthan|madhya pradesh|uttar pradesh|bihar|punjab|haryana|karnataka|kerala|tamil nadu|telangana|andhra pradesh|west bengal|india)$/i;
const locationKey=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
// Preserve reported text; only split an explicit locality/city pair or a known
// city suffix. A city followed by its state must never become an area/city pair.
export function parseResidence(raw:string):{city:string;area?:string}{
 const value=raw.trim().slice(0,1000);
 if(/\b(ctc|salary|monthly|annually|yearly|thousand|lakh|lpa|per month|per year|on hand|deduction)\b/i.test(value))return {city:''};
 const known=value.match(/^(?:(.+?)[,\s]+)?(Ahmedabad|Ahemdabad|Gandhinagar|Vadodara|Baroda|Surat|Rajkot|Mumbai|Pune|Delhi|Bengaluru|Bangalore|Jaipur)(?:[,\s]+(?:Gujarat|Maharashtra|Rajasthan|Karnataka|India))*[.\s]*$/i);
 if(known){const area=known[1]?.replace(/[,\s]+$/,'').trim();return {city:known[2],...(area&&!stateOnly.test(area)?{area}:{})};}
 const parts=value.split(/[,\n]+/).map(s=>s.trim()).filter(Boolean);
 while(parts.length>1&&stateOnly.test(parts[parts.length-1]))parts.pop();
 return parts.length>1?{area:parts.slice(0,-1).join(', '),city:parts[parts.length-1]}:{city:parts[0]||value};
}
export function residenceDetails(answers:Record<string,any>){
 const result={...answers};
 if(result.residence&&!result.residence_city){const parsed=parseResidence(result.residence);if(parsed.city){result.residence_city=parsed.city;if(parsed.area)result.residence_area=parsed.area;}else{result.residence_as_reported=result.residence;delete result.residence;}}
 if(result.residence_city&&result.residence_area)result.residence=`${result.residence_area}, ${result.residence_city}`;
 return result;
}
export const isCvDeferred=(text:string)=>/\b(later|send later|will (?:send|share|upload|forward)|(?:send|share|upload) (?:it |my cv |the cv )?(?:by |on )?(?:today|tomorrow|tonight)|no cv|don.t have|dont have)\b/i.test(text)
 || /^(?:ok(?:ay)?|yes|sure|will do|interested|i am interested)[.!\s]*$/i.test(text.trim());
export type IncomingRecruitment = {phoneNumber:string;content?:string;sourceMessageId?:string;messageType?:string;receivedAt?:number;mediaBuffer?:Buffer;mediaInfo?:{mimetype?:string;fileName?:string}};
export function validRecruitmentPhone(value:string):string {
 if(!/^\+?[\d\s()-]+$/.test(value))throw new Error('Invalid phone number');
 let d=value.replace(/\D/g,'');if(d.length===10)d='91'+d;
 if(!/^91[6-9]\d{9}$/.test(d))throw new Error('A valid Indian mobile number is required');
 return d;
}
function cvFile(input:IncomingRecruitment):{name:string;mime:string;base64:string}|null {
 const b=input.mediaBuffer;if(!b?.length)return null;
 if(b.length>10*1024*1024)throw new Error('Please send a CV smaller than 10 MB.');
 const mime=(input.mediaInfo?.mimetype||'').split(';')[0].toLowerCase();
 const checks:Record<string,boolean>={
  'application/pdf':b.subarray(0,5).toString()==='%PDF-',
  'image/jpeg':b[0]===0xff&&b[1]===0xd8,
  'image/png':b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':b[0]===0x50&&b[1]===0x4b,
  'application/msword':b.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225])),
 };
 if(!checks[mime])throw new Error('Please send your CV as a PDF, Word document, JPEG or PNG photo.');
 const extensions:Record<string,string>={'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','application/msword':'doc','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx'};
 const name=(input.mediaInfo?.fileName||`CV.${extensions[mime]}`).replace(/[\x00-\x1f\\/"<>:|?*]/g,'_').slice(0,160);
 return {name,mime,base64:b.toString('base64')};
}
export class RecruitmentStore {
 constructor(public database:CloudDatabase){}
 async list(t:Tenant){return this.database.query(`SELECT c.*, (SELECT count(*)::int FROM recruitment_cv_files f WHERE f.candidate_id=c.id) cv_count,
 (SELECT max(created_at) FROM recruitment_events e WHERE e.candidate_id=c.id) last_reply_at
 FROM recruitment_candidates c WHERE c.organization_id=$1 AND c.user_id=$2 ORDER BY c.created_at,c.name`,[t.organizationId,t.userId]);}
 async enroll(t:Tenant,sessionName:string,recipients:Array<{phone:string;name:string;sourceLeadId:string;consentNote?:string}>){
  const phones=recipients.map(r=>validRecruitmentPhone(r.phone));
  if(new Set(phones).size!==phones.length)throw new Error('Duplicate recipient');
  return this.database.transaction(async q=>{
   for(let i=0;i<recipients.length;i++){
    const r=recipients[i];
    await q(`INSERT INTO recruitment_candidates(id,organization_id,user_id,session_name,phone,name,source_lead_id,consent_note)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,user_id,session_name,phone) DO NOTHING`,
    [randomUUID(),t.organizationId,t.userId,sessionName,phones[i],r.name,r.sourceLeadId,r.consentNote||null]);
   }
  });
 }
 async consume(t:Tenant,sessionName:string,input:IncomingRecruitment):Promise<{handled:boolean;reply?:string;eventId?:string;candidateId?:string}> {
  const phone=input.phoneNumber.replace(/\D/g,'');
  return this.database.transaction(async q=>{
   const [c]=await q(`SELECT * FROM recruitment_candidates WHERE organization_id=$1 AND user_id=$2 AND session_name=$3 AND phone=$4 FOR UPDATE`,[t.organizationId,t.userId,sessionName,phone]);
   if(!c)return {handled:false};
   // Enrolled applicants never fall through to patient or sales bots.
   if(!input.sourceMessageId)return {handled:true};
   if(input.receivedAt&&Date.now()-input.receivedAt>=24*60*60*1000)return {handled:true};
   const [prior]=await q('SELECT id FROM recruitment_events WHERE candidate_id=$1 AND source_message_id=$2',[c.id,input.sourceMessageId]);
   if(prior)return {handled:true};
   const text=(input.content||'').trim();const lower=text.toLowerCase();
   const answers=residenceDetails(c.answers);let status=c.status;let awaiting=c.awaiting_field==='residence'?'residence_city':c.awaiting_field;let reply:string|undefined;
   let file:ReturnType<typeof cvFile>=null;let fileError='';
   const isMedia=['image','document'].includes(input.messageType||'');
   if(isMedia){try{file=cvFile(input);if(!file)fileError='The CV download failed. Please attach it again.';}catch(e){fileError=e instanceof Error?e.message:'Could not save the CV.';}}
   const stop=/^(stop|unsubscribe|cancel|not interested|no longer interested|not looking|job found|already joined)[.!\s]*$/i.test(text);
   if(stop){status='declined';awaiting=null;reply='Understood. We have stopped this recruitment follow-up. Thank you for letting us know.';}
   else if(status==='declined'||status==='paused'){return {handled:true};}
   else if(isHumanRequest(text)){
    if(answers.residence_area===text){answers.residence_area_as_reported=text;delete answers.residence_area;answers.residence=answers.residence_city||'';answers._review_required={...(answers._review_required||{}),residence_area:'Applicant requested a call'};}
    status='paused';reply='I have paused the automated questions. The recruitment team can follow up with you here.';
   }
   else {
    const asks:Record<string,number>={...(answers._question_asks||{})};
    if(!answers._question_asks){
     const events=await q('SELECT reply FROM recruitment_events WHERE candidate_id=$1 ORDER BY created_at',[c.id]);
     for(const event of events){const key=questionInReply(event.reply||'');if(key)asks[key]=(asks[key]||0)+1;}
    }
    const review:Record<string,string>={...(answers._review_required||{})};
    if(awaiting&&!input.sourceMessageId.startsWith('reprocess')){
     const raw={...(answers._raw_responses||{})};
     raw[awaiting]=[...(raw[awaiting]||[]),{content:text.slice(0,1000),type:input.messageType||'text',source_message_id:input.sourceMessageId}].slice(-20);
     answers._raw_responses=raw;
    }
    if(file){
     await q(`INSERT INTO recruitment_cv_files(id,candidate_id,source_message_id,file_name,mime_type,data) VALUES($1,$2,$3,$4,$5,decode($6,'base64')) ON CONFLICT(candidate_id,source_message_id) DO NOTHING`,[randomUUID(),c.id,input.sourceMessageId,file.name,file.mime,file.base64]);
    }
    const [cv]=await q('SELECT count(*)::int count FROM recruitment_cv_files WHERE candidate_id=$1',[c.id]);
    const hasCv=cv.count>0;
    const skipCv=isCvDeferred(text);
    const firstCvDeferral=skipCv&&!hasCv&&!answers.cv_deferred;
    if(skipCv)answers.cv_deferred=true;
    // Labeled answers can arrive together and do not depend on the last question.
    const labels:Record<string,string>={'current organisation':'current_organisation','current organization':'current_organisation','organisation':'current_organisation','organization':'current_organisation','current ctc':'current_ctc','expected ctc':'expected_ctc','residence':'residence','place of residence':'residence','location':'residence','city':'residence_city','area':'residence_area','locality':'residence_area'};
    let labeled=false;
    // An explicitly named salary correction remains a salary answer even if
    // it arrives after the bot has moved on to the residence question.
    if(!isMedia&&/\bexpected\s*(?:ctc|salary)\b/i.test(text)&&/\b(month|monthly|annual|annually|year|yearly|pm|p\.m|pa|p\.a|lpa)\b/i.test(text)){answers.expected_ctc=text.slice(0,1000);labeled=true;}
    if(!isMedia)for(const line of text.split(/\n/)){
     const match=line.match(/^\s*([^:]+):\s*(.+)$/);if(!match)continue;
     const key=labels[match[1].toLowerCase().trim()];if(key){
      const value=match[2].trim().slice(0,1000);
      if(key==='residence'){const parsed=parseResidence(value);if(parsed.city){answers.residence=value;answers.residence_city=parsed.city;delete answers.residence_area;if(parsed.area)answers.residence_area=parsed.area;}}
      else answers[key]=value;
      labeled=true;
     }
    }
    for(const key of ['current_ctc','expected_ctc']){
     if(answers[key]&&!/\b(month|monthly|monthwise|pm|p\.m|annual|annually|year|yearly|pa|p\.a|lpa|prefer not|not applicable|unemployed|not working|fresher|none)\b/i.test(answers[key]))delete answers[key];
    }
    const control=/^(hi|hello|hey|yes|ok|okay|interested|i am interested|still interested|continue|start|thank you|thanks)[.!\s]*$/i.test(text);
    if(!labeled&&!isMedia&&!control&&!skipCv&&awaiting&&order.includes(awaiting)&&text&&!text.includes('?')&&!/^\[/.test(text)){
     // Never guess whether a bare salary is monthly or annual.
     const ctc=awaiting.endsWith('_ctc');
     if(awaiting==='residence_city'){const parsed=parseResidence(text);if(parsed.city){answers.residence=text.slice(0,1000);answers.residence_city=parsed.city;if(parsed.area)answers.residence_area=parsed.area;}}
     else if(awaiting==='residence_area'){
      const parsed=parseResidence(text);
      if(parsed.area&&locationKey(parsed.city)===locationKey(answers.residence_city||''))answers.residence_area=parsed.area;
      else if(parsed.city&&!parsed.area&&!stateOnly.test(text)&&locationKey(parsed.city)!==locationKey(answers.residence_city||''))answers.residence_area=text.slice(0,1000);
     }
     else if(!ctc||/\b(month|monthly|monthwise|pm|p\.m|annual|annually|year|yearly|pa|p\.a|lpa|prefer not|not applicable|unemployed|not working|fresher|none)\b/i.test(text))answers[awaiting]=text.slice(0,1000);
    }
    if(answers.residence_area&&(stateOnly.test(answers.residence_area)||locationKey(answers.residence_area)===locationKey(answers.residence_city||'')))delete answers.residence_area;
    if(answers.residence_city&&answers.residence_area)answers.residence=`${answers.residence_area}, ${answers.residence_city}`;
    for(const key of order)if(answers[key])delete review[key];
    if(hasCv)delete review.cv;
    // A reply always advances the retry budget, regardless of its format or
    // whether validation understood it. Keep unconfirmed text for the team.
    if(awaiting&&(awaiting==='cv'?!hasCv:!answers[awaiting])&&(asks[awaiting]||0)>=MAX_QUESTION_ASKS){
     review[awaiting]='Unclear after two repeats';
     answers[awaiting+'_as_reported']=text.slice(0,1000)||`[${input.messageType||'empty reply'}]`;
    }
    for(const key of [...order,'cv'])if((key==='cv'?!hasCv:!answers[key])&&(asks[key]||0)>=MAX_QUESTION_ASKS&&!review[key])review[key]='Unclear after two repeats';
    const next=order.find(k=>!answers[k]&&!review[k]);
    const question=(key:string)=>key==='residence_area'&&answers.residence_city?`Which area or locality in ${answers.residence_city} do you currently live in? Your full home address is not needed.`:questions[key];
    if(!hasCv&&!answers.cv_deferred&&!review.cv){awaiting='cv';reply=questions.cv;}
    else if(next){awaiting=next;status='collecting';reply=(file?'Your CV has been saved. ':firstCvDeferral?'Sure, you can share your updated CV when ready. Meanwhile, ':'')+question(next);}
    else if(!hasCv&&!review.cv){awaiting='cv';reply='Thank you. Your responses are saved. Please attach your latest CV when ready to complete your profile.';}
    else if(Object.keys(review).length){awaiting=null;status='needs_review';reply='Thank you. Your responses have been recorded. The recruitment team will review them and clarify any missing details with you.';}
    else{awaiting=null;status='complete';reply='Thank you. Your latest CV and the four details are saved for the recruitment team to review. They will contact you if they need anything further.';}
    if(awaiting)status='collecting';
    if(fileError)reply=fileError+' '+reply;
    if(awaiting&&(input.messageType==='audio'||input.messageType==='voice_note'))reply='Please type your response if possible. '+reply;
    const asked=questionInReply(reply||'');if(asked)asks[asked]=(asks[asked]||0)+1;
    answers._question_asks=asks;answers._review_required=review;
   }
   const eventId=randomUUID();
   await q(`UPDATE recruitment_candidates SET status=$2,answers=$3::jsonb,awaiting_field=$4,updated_at=now() WHERE id=$1`,[c.id,status,JSON.stringify(answers),awaiting]);
   await q(`INSERT INTO recruitment_events(id,candidate_id,source_message_id,reply) VALUES($1,$2,$3,$4)`,[eventId,c.id,input.sourceMessageId,reply||null]);
   return {handled:true,reply,eventId,candidateId:c.id};
  });
 }
 async outcome(eventId:string,status:'sent'|'unknown',messageId?:string,error?:string){
  await this.database.transaction(async q=>{
   await q('UPDATE recruitment_events SET send_status=$2,message_id=$3,error_reason=$4 WHERE id=$1',[eventId,status,messageId||null,error?.slice(0,500)||null]);
   if(status==='sent')await q(`INSERT INTO messages(id,organization_id,user_id,phone_number,content,type,status,metadata,sent_at)
    SELECT e.id,c.organization_id,c.user_id,c.phone,e.reply,'text','sent',jsonb_build_object('recruitment_reply',true,'whatsappId',e.message_id),now()
    FROM recruitment_events e JOIN recruitment_candidates c ON c.id=e.candidate_id WHERE e.id=$1 AND e.reply IS NOT NULL
    ON CONFLICT(id) DO NOTHING`,[eventId]);
  });
 }
 async files(t:Tenant,id:string){return this.database.query(`SELECT f.id,f.file_name,f.mime_type,f.created_at FROM recruitment_cv_files f JOIN recruitment_candidates c ON c.id=f.candidate_id WHERE c.id=$1 AND c.organization_id=$2 AND c.user_id=$3 ORDER BY f.created_at DESC`,[id,t.organizationId,t.userId]);}
 async questionCounts(t:Tenant,id:string){
  const events=await this.database.query(`SELECT e.reply FROM recruitment_events e JOIN recruitment_candidates c ON c.id=e.candidate_id WHERE c.id=$1 AND c.organization_id=$2 AND c.user_id=$3 ORDER BY e.created_at`,[id,t.organizationId,t.userId]);
  const counts:Record<string,number>={};for(const e of events){const key=questionInReply(e.reply||'');if(key)counts[key]=(counts[key]||0)+1;}return counts;
 }
 async conversation(t:Tenant,id:string){return this.database.query(`SELECT m.id,m.content,m.type,m.status,m.created_at,m.sent_at,m.metadata
  FROM messages m JOIN recruitment_candidates c ON c.organization_id=m.organization_id AND c.user_id=m.user_id AND c.phone=m.phone_number
  WHERE c.id=$1 AND c.organization_id=$2 AND c.user_id=$3 ORDER BY m.created_at DESC LIMIT 100`,[id,t.organizationId,t.userId]);}
 async download(t:Tenant,id:string):Promise<Row|undefined>{return (await this.database.query(`SELECT f.file_name,f.mime_type,encode(f.data,'base64') data FROM recruitment_cv_files f JOIN recruitment_candidates c ON c.id=f.candidate_id WHERE f.id=$1 AND c.organization_id=$2 AND c.user_id=$3`,[id,t.organizationId,t.userId]))[0];}
}
