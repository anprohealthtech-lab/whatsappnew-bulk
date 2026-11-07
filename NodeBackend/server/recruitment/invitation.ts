export const ACCOUNTANT_CV_TEMPLATE='accountant_application_cv_request';
export function accountantInvitation(template:{name?:string;language?:string;status?:string;category?:string},name:string){
 if(template.name!==ACCOUNTANT_CV_TEMPLATE||template.language!=='en')throw new Error('Select the accountant application CV request template');
 if(template.status!=='APPROVED')throw new Error('The accountant CV request template is still awaiting approval');
 if(template.category!=='UTILITY')throw new Error('The accountant CV request template must be approved as Utility');
 return {templateName:ACCOUNTANT_CV_TEMPLATE,language:'en',bodyParams:[name]};
}
