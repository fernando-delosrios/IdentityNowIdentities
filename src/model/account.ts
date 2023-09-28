import { Attributes } from '@sailpoint/connector-sdk'
import { Account } from 'sailpoint-api-client'

export class MergedAccount {
    identity: string
    uuid: string
    attributes: Attributes

    constructor(account: Account | string, message?: string, status?: string) {
        const now = new Date().toISOString()
        let history: string[]
        let finalStatus = status ? [status] : []
        if (typeof account === 'string') {
            history = []
        } else {
            history = [...(account.attributes!.history as string[])]
        }

        if (typeof account !== 'string') {
            finalStatus = [...(account.attributes!.status as string[]), ...finalStatus]
        }

        if (message) {
            history.push(`[${now}] ${message}`)
        }

        this.attributes = {
            id: typeof account === 'string' ? account : (account.name as string),
            history,
            status: finalStatus,
            reviews: [],
        }

        this.identity = this.attributes.id as string
        this.uuid = this.attributes.id as string
    }
}

export class UniqueAccount {
    identity: string
    uuid: string
    attributes: Attributes

    constructor(id: string, account: Account) {
        this.attributes = account.attributes
        this.attributes.id = id
        this.attributes.name = account.name
        this.attributes.nativeId = account.nativeIdentity
        this.attributes.source = account.sourceName

        this.identity = this.attributes.id as string
        this.uuid = this.attributes.name as string
    }
}
