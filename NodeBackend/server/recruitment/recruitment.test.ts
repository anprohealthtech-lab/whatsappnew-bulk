import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {RecruitmentStore,validRecruitmentPhone,questions} from './store';
import {recruitmentSchemaSql} from './schema';
import {ACCOUNTANT_CV_TEMPLATE,accountantInvitation} from './invitation';
import {templateComponents} from '../cloud/model';
const pg=new PGlite();
const database={query:async(text:string,params:any[]=[]) => (await pg.query(text,params)).rows as any[],transaction:<T>(fn:any):Promise<T>=>pg.transaction(tx=>fn(async(text:string,params:any[]=[]) => (await tx.query(text,params)).rows))};
const store=new RecruitmentStore(database);
const t={organizationId:'clinic',userId:'owner'},other={organizationId:'other',userId:'owner'};
const recipient={phone:'+91 98765 43210',name:'Applicant',sourceLeadId:'lead-1'};
let sequence=0;
const incoming=(content:string,rest:any={})=>({phoneNumber:'919876543210',content,sourceMessageId:'message-'+(++sequence),messageType:'text',...rest});
const reply=(content:string,rest:any={})=>store.consume(t,'cloud',incoming(content,rest));
const cv=()=>incoming('[Document: CV.pdf]',{messageType:'document',mediaInfo:{mimetype:'application/pdf',fileName:'CV.pdf'},mediaBuffer:Buffer.from('%PDF-1.7\nCV fixture')});
before(async()=>{await pg.exec(recruitmentSchemaSql);await pg.exec(recruitmentSchemaSql);await pg.exec('CREATE TABLE messages(id text PRIMARY KEY,organization_id text,user_id text,phone_number text,content text,type text,status text,metadata jsonb,sent_at timestamptz,created_at timestamptz DEFAULT now())');});
beforeEach(async()=>{await pg.exec('TRUNCATE messages,recruitment_events,recruitment_cv_files,recruitment_candidates CASCADE');await store.enroll(t,'cloud',[recipient]);});
after(()=>pg.close());

test('application invitation uses the approved Utility template and one name parameter',()=>{
 const template={name:ACCOUNTANT_CV_TEMPLATE,language:'en',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'Hello {{1}}, please share your updated CV.'}]};
 const invitation=accountantInvitation(template,'Applicant');
 assert.equal(invitation.templateName,ACCOUNTANT_CV_TEMPLATE);
 assert.deepEqual(templateComponents(template,invitation.bodyParams,[],[]),[{type:'body',parameters:[{type:'text',text:'Applicant'}]}]);
 assert.throws(()=>accountantInvitation({...template,status:'PENDING'},'Applicant'),/approval/);
 assert.throws(()=>accountantInvitation({...template,category:'MARKETING'},'Applicant'),/Utility/);
 assert.throws(()=>accountantInvitation({...template,name:'cv_received'},'Applicant'),/accountant application/);
});

test('validates applicant phone numbers and rejects malformed source values',()=>{
 assert.equal(validRecruitmentPhone('9876543210'),'919876543210');
 assert.throws(()=>validRecruitmentPhone('+91851103071800((,4'));
 assert.throws(()=>validRecruitmentPhone('=9876543210'));
});
test('enrollment is idempotent and never sends or resets answers',async()=>{
 await reply('hello');await store.enroll(t,'cloud',[recipient]);
 assert.equal((await store.list(t)).length,1);assert.equal((await store.list(t))[0].status,'collecting');
 await assert.rejects(()=>store.enroll(t,'cloud',[recipient,recipient]),/Duplicate/);
});
test('tenant and receiving session must both match',async()=>{
 assert.equal((await store.consume(other,'cloud',incoming('hi'))).handled,false);
 assert.equal((await store.consume(t,'other-session',incoming('hi'))).handled,false);
 assert.equal((await store.list(other)).length,0);
});
test('CV-first intake saves binary privately then asks four sequential questions',async()=>{
 assert.equal((await reply('hello')).reply,questions.cv);
 const next=await store.consume(t,'cloud',cv());assert.match(next.reply!,/CV has been saved/);assert.match(next.reply!,/current organisation/);
 assert.equal((await reply('Example Accountancy LLP')).reply,questions.current_ctc);
 assert.equal((await reply('INR 30000 monthly')).reply,questions.expected_ctc);
 assert.equal((await reply('INR 40000 monthly')).reply,questions.residence);
 assert.match((await reply('Bopal, Ahmedabad')).reply!,/recruitment team/);
 const [c]=await store.list(t);assert.equal(c.status,'complete');assert.equal(c.cv_count,1);assert.equal(c.answers.current_organisation,'Example Accountancy LLP');
 const [file]=await store.files(t,c.id);const downloaded=await store.download(t,file.id);assert.equal(Buffer.from(downloaded!.data,'base64').toString(),'%PDF-1.7\nCV fixture');
 assert.equal(await store.download(other,file.id),undefined);assert.deepEqual(await store.files(other,c.id),[]);
});
test('duplicate webhook does not produce another reply, update answers or duplicate CV',async()=>{
 const msg=cv();const first=await store.consume(t,'cloud',msg);const again=await store.consume(t,'cloud',msg);
 assert.ok(first.eventId);assert.equal(again.reply,undefined);assert.equal((await store.list(t))[0].cv_count,1);
 const events=await database.query('SELECT * FROM recruitment_events');assert.equal(events.length,1);
});
test('CV deferral collects answers and leaves profile incomplete until attachment arrives',async()=>{
 await reply('send later');await reply('not currently working');await reply('not applicable');await reply('INR 4.8 LPA');
 assert.match((await reply('Shela, Ahmedabad')).reply!,/attach your latest CV/);
 assert.equal((await store.list(t))[0].status,'collecting');
 assert.match((await store.consume(t,'cloud',cv())).reply!,/four details are saved/);
 assert.equal((await store.list(t))[0].status,'complete');
});
test('a promise to share the CV today moves on to organisation instead of requesting the CV again',async()=>{
 await reply('hello');
 const result=await reply('Ok will share it by today');
 assert.match(result.reply!,/when ready/);assert.match(result.reply!,/current organisation/);
 const [candidate]=await store.list(t);assert.equal(candidate.answers.cv_deferred,true);assert.equal(candidate.awaiting_field,'current_organisation');
 assert.equal((await reply('Example Accountants LLP')).reply,questions.current_ctc);
});
test('an acknowledgement starts the four questions while leaving CV outstanding',async()=>{
 const next=await reply('Ok');assert.match(next.reply!,/current organisation/);
 const [candidate]=await store.list(t);assert.equal(candidate.cv_count,0);assert.equal(candidate.answers.cv_deferred,true);assert.equal(candidate.awaiting_field,'current_organisation');
});
test('bare salary is clarified, never silently assumed monthly or annual',async()=>{
 await reply('send later');await reply('Example Company');
 assert.equal((await reply('30000')).reply,questions.current_ctc);
 assert.equal((await store.list(t))[0].answers.current_ctc,undefined);
 assert.equal((await reply('prefer not to share')).reply,questions.expected_ctc);
});
test('labeled answers in one message are retained and corrections can be made',async()=>{
 await reply('send later');
 await reply('Current organisation: Example LLP\nCurrent CTC: INR 30000 monthly\nExpected CTC: INR 40000 monthly\nResidence: Bopal, Ahmedabad');
 assert.equal((await store.list(t))[0].answers.residence,'Bopal, Ahmedabad');
 await reply('Expected CTC: INR 45000 monthly');assert.equal((await store.list(t))[0].answers.expected_ctc,'INR 45000 monthly');
});

test('city and state alone require locality, and repeating the city does not complete the profile',async()=>{
 await store.consume(t,'cloud',cv());await reply('Example LLP');await reply('30000 monthly');await reply('40000 monthly');
 const city=await reply('Ahmedabad Gujarat');assert.match(city.reply!,/area or locality in Ahmedabad/);
 let [c]=await store.list(t);assert.equal(c.status,'collecting');assert.equal(c.awaiting_field,'residence_area');assert.equal(c.answers.residence_city,'Ahmedabad');assert.equal(c.answers.residence_area,undefined);
 await reply('Ahmedabad, Gujarat');assert.equal((await store.list(t))[0].status,'collecting');
 await reply('Gujarat');assert.equal((await store.list(t))[0].answers.residence_area,undefined);
 await reply('South Bopal');[c]=await store.list(t);assert.equal(c.status,'complete');assert.equal(c.answers.residence_area,'South Bopal');assert.equal(c.answers.residence,'South Bopal, Ahmedabad');assert.equal(c.cv_count,1);
});

test('legacy completed city-only profile reopens for locality without losing CV or salary answers',async()=>{
 await store.consume(t,'cloud',cv());
 const legacy={current_organisation:'Example LLP',current_ctc:'1200000 p.a.',expected_ctc:'100000 p.m.',residence:'Ahmedabad Gujarat'};
 await database.query("UPDATE recruitment_candidates SET status='complete',awaiting_field=NULL,answers=$1::jsonb",[JSON.stringify(legacy)]);
 const msg=incoming('Ahmedabad Gujarat',{sourceMessageId:'reprocess-residence:original'});
 assert.match((await store.consume(t,'cloud',msg)).reply!,/area or locality in Ahmedabad/);
 assert.equal((await store.consume(t,'cloud',msg)).reply,undefined);
 const [c]=await store.list(t);assert.equal(c.status,'collecting');assert.equal(c.awaiting_field,'residence_area');assert.equal(c.cv_count,1);assert.equal(c.answers.current_ctc,legacy.current_ctc);
 await reply('Shela, Ahmedabad');assert.equal((await store.list(t))[0].status,'complete');
});

test('separate labeled city and area are retained as distinct residence fields',async()=>{
 await reply('send later');await reply('City: Ahmedabad\nArea: Bopal');
 const [c]=await store.list(t);assert.equal(c.answers.residence_city,'Ahmedabad');assert.equal(c.answers.residence_area,'Bopal');assert.equal(c.answers.residence,'Bopal, Ahmedabad');
});

test('late explicit salary correction is not mistaken for a city or locality',async()=>{
 await store.consume(t,'cloud',cv());await reply('Example LLP');await reply('261780 yearly');await reply('21815 monthly');
 assert.equal((await reply('I was expected ctc monthly in 30 thousand on hand')).reply,questions.residence);
 let [c]=await store.list(t);assert.equal(c.status,'collecting');assert.equal(c.answers.residence_city,undefined);assert.match(c.answers.expected_ctc,/30 thousand/);
 await reply('Ahmedabad');await reply('30000 monthly');[c]=await store.list(t);assert.equal(c.awaiting_field,'residence_area');assert.equal(c.answers.residence_area,undefined);
});

test('legacy salary stored as residence is repaired using the original actual reply',async()=>{
 await store.consume(t,'cloud',cv());
 const text='I was expected ctc monthly in 30 thousand on hand';
 await database.query("UPDATE recruitment_candidates SET status='complete',awaiting_field=NULL,answers=$1::jsonb",[JSON.stringify({current_organisation:'Example LLP',current_ctc:'261780 yearly',expected_ctc:'21815 monthly',residence:text})]);
 assert.equal((await reply(text)).reply,questions.residence);
 const [c]=await store.list(t);assert.equal(c.awaiting_field,'residence_city');assert.equal(c.answers.residence_city,undefined);assert.equal(c.answers.residence_as_reported,text);assert.equal(c.answers.expected_ctc,text);
});
test('opt-out and human handoff prevent fallback bots and further automated questions',async()=>{
 assert.match((await reply('not interested')).reply!,/stopped/);
 assert.equal((await reply('hello')).reply,undefined);
 assert.equal((await store.list(t))[0].status,'declined');
});
test('human request pauses the recruitment conversation',async()=>{
 assert.match((await reply('call me')).reply!,/paused/);assert.equal((await reply('hello')).reply,undefined);
 assert.equal((await store.list(t))[0].status,'paused');
});
test('invalid file bytes are rejected without marking a CV received',async()=>{
 const next=await reply('[Document: CV.pdf]',{messageType:'document',mediaInfo:{mimetype:'application/pdf',fileName:'CV.pdf'},mediaBuffer:Buffer.from('<html>not PDF</html>')});
 assert.match(next.reply!,/PDF, Word/);assert.equal((await store.list(t))[0].cv_count,0);
});
test('old webhook outside service window is ignored without a free-form reply',async()=>{
 assert.equal((await reply('hello',{receivedAt:Date.now()-25*60*60*1000})).reply,undefined);
 assert.equal((await store.list(t))[0].status,'awaiting_reply');
});
test('accepted replies appear once in tenant message history, ambiguous sends do not',async()=>{
 const first=await reply('hello');await store.outcome(first.eventId!,'sent','wamid.reply1');await store.outcome(first.eventId!,'sent','wamid.reply1');
 const logs=await database.query('SELECT * FROM messages');assert.equal(logs.length,1);assert.equal(logs[0].organization_id,t.organizationId);assert.equal(logs[0].metadata.whatsappId,'wamid.reply1');
 const [candidate]=await store.list(t);assert.equal((await store.conversation(t,candidate.id)).length,1);assert.deepEqual(await store.conversation(other,candidate.id),[]);
 const second=await reply('send later');await store.outcome(second.eventId!,'unknown',undefined,'timeout');
 assert.equal((await database.query('SELECT * FROM messages')).length,1);
});
