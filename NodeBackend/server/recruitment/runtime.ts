import {cloudStore} from '../cloud/runtime';
import {RecruitmentStore,type IncomingRecruitment} from './store';
import type {Tenant} from '../cloud/model';

export const recruitmentStore=new RecruitmentStore(cloudStore.database);
export async function handleRecruitment(t:Tenant,sessionName:string,input:IncomingRecruitment,session:{sendTextMessage:(to:string,text:string)=>Promise<any>}):Promise<boolean>{
 const result=await recruitmentStore.consume(t,sessionName,input);
 if(!result.handled)return false;
 if(result.reply&&result.eventId){
  // Write the reply intent before sending; ambiguous attempts are never auto-retried.
  try{
   const sent=await session.sendTextMessage(input.phoneNumber,result.reply);
   await recruitmentStore.outcome(result.eventId,'sent',sent?.id||sent?.messageId);
  }catch(e){
   await recruitmentStore.outcome(result.eventId,'unknown',undefined,e instanceof Error?e.message:'Reply could not be confirmed');
  }
 }
 return true;
}
