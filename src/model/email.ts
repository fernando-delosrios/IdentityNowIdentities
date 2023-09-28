import { FormInstanceResponseBeta, TestWorkflowRequestBeta } from 'sailpoint-api-client'

export class Email implements TestWorkflowRequestBeta {
    input: object
    constructor(recipients: string[], formName: string, instance: FormInstanceResponseBeta) {
        const subject = formName
        const body = instance.standAloneFormUrl!
        // this.recipients = recipients
        // this.subject = subject
        // this.body = body
        this.input = {
            recipients,
            subject,
            body,
        }
    }
}
