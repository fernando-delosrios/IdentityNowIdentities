import {
    logger,
    ConnectorError,
    createConnector,
    StdAccountListHandler,
    StdTestConnectionHandler,
    StdAccountDiscoverSchemaHandler,
    SchemaAttribute,
    StdAccountReadHandler,
    StdAccountCreateHandler,
    StdAccountCreateOutput,
    StdEntitlementListHandler,
    StdEntitlementListOutput,
    StdAccountListOutput,
} from '@sailpoint/connector-sdk'
import { SDKClient } from './sdk-client'
import { UniqueAccount } from './model/account'
import { Account, AttributeDefinition, Source } from 'sailpoint-api-client'

const getUniqueID = (id: string, currentIDs: string[]) => {
    let counter = 1
    let candidate = id
    while (currentIDs.includes(candidate)) {
        candidate = id + counter++
    }
    currentIDs.push(candidate)

    return candidate
}

export const authoritative = async (config: any) => {
    const { baseurl, clientId, clientSecret, 'authoritative.template': template } = config
    const client = new SDKClient({ baseurl, clientId, clientSecret })

    const getCurrentSource = async (config: any): Promise<Source | undefined> => {
        const sources = (await client.listSources()).find((x) => (x.connectorAttributes as any).id === config.id)

        return sources
    }

    const getSourcesByName = async (names: string[]): Promise<Source[]> => {
        const sources = await client.listSources()

        return sources.filter((x) => names.includes(x.name))
    }

    const getCurrentAccounts = async (): Promise<Account[]> => {
        const source = await getCurrentSource(config)

        if (!source) {
            throw new Error('No connector source was found on the tenant.')
        }

        const currentAccounts = await client.listAccountsBySource(source.id!)

        return currentAccounts
    }

    //==============================================================================================================

    const stdTest: StdTestConnectionHandler = async (context, input, res) => {
        const source = await getCurrentSource(config)
        if (source) {
            logger.info('Test successful!')
            res.send({})
        } else {
            throw new ConnectorError('Unable to connect to IdentityNow! Please check your Username and Password')
        }
    }

    const stdAccountList: StdAccountListHandler = async (context, input, res) => {
        const source = await getCurrentSource(config)
        const accounts: StdAccountListOutput[] = []

        if (!source) {
            throw new Error('No connector source was found on the tenant.')
        }

        const identities = await client.listIdentities()
        const currentAccounts = await client.listAccountsBySource(source.id!)

        for (const identity of identities) {
            const currentAccount = currentAccounts.find(x => x.identityId === identity.id)
            if (currentAccount) {
                const account:StdAccountListOutput = {
                    identity: currentAccount.nativeIdentity,
                    uuid: currentAccount.name,
                    attributes: currentAccount.attributes
                }
                accounts.push(account)
            } else {
                const uniqueID = getUniqueID()
            }
        }

        const currentIDs = currentAccounts.map((x) => x.nativeIdentity)

        let sourceAccounts: Account[] = []
        for (const source of sourceList) {
            const accounts = await client.listAccountsBySource(source.id!)
            sourceAccounts = [...sourceAccounts, ...accounts]
        }

        for (const sourceAccount of sourceAccounts) {
            let uniqueID: string
            const currentAccount = currentAccounts.find(
                (x) =>
                    x.attributes.nativeId === sourceAccount.nativeIdentity &&
                    x.attributes.source === sourceAccount.sourceName
            )
            if (currentAccount) {
                uniqueID = currentAccount.nativeIdentity!
                const account = new UniqueAccount(uniqueID, sourceAccount)
                accounts.push(account)
            } else {
                // uniqueID = getUniqueID(sourceAccount.nativeIdentity, currentIDs)
            }
        }

        for (const account of accounts) {
            logger.info(account)
            res.send(account)
        }
    }

    const stdAccountRead: StdAccountReadHandler = async (context, input, res) => {
        const source = await getCurrentSource(config)

        if (!source) {
            throw new Error('No connector source was found on the tenant.')
        }

        const currentAccounts = await client.listAccountsBySource(source.id!)
        const currentAccount = currentAccounts.find((x) => x.nativeIdentity === input.identity)
        if (currentAccount) {
            const account = new UniqueAccount(currentAccount.nativeIdentity, currentAccount)
            logger.info(account)
            res.send(account)
        }
    }

    const stdAccountDiscoverSchema: StdAccountDiscoverSchemaHandler = async (context, input, res) => {
        const sourceList = await getSourcesByName(sources)
        let sourceAttributes: AttributeDefinition[] = []
        const attributes: SchemaAttribute[] = [
            {
                name: 'id',
                description: 'Unique ID',
                type: 'string',
            },
            {
                name: 'name',
                description: 'Native account name',
                type: 'string',
            },
            {
                name: 'nativeId',
                description: 'Native account ID',
                type: 'string',
            },
            {
                name: 'source',
                description: 'Native account source',
                type: 'string',
            },
        ]
        // for (const source of sourceList) {
        //     const schemas = await client.listSourceSchemas(source.id!)
        //     for (const schema of schemas) {
        //         if (schema.name === 'account') {
        //             for (const attribute of schema.attributes ? schema.attributes : []) {
        //                 if (!attributes.find((x) => x.name === attribute.name!)) {
        //                     const description = attribute.description
        //                         ? `${source.name} - ${attribute.description!}`
        //                         : source.name
        //                     const schemaAttribute: SchemaAttribute = {
        //                         name: attribute.name!,
        //                         description,
        //                         type: attribute.type!.toLowerCase(),
        //                         multi: attribute.isMultiValued,
        //                     }
        //                     attributes.push(schemaAttribute)
        //                 }
        //             }
        //         }
        //     }
        // }

        const schema: any = {
            attributes,
            displayAttribute: 'name',
            identityAttribute: 'id',
        }

        logger.info(schema)
        res.send(schema)
    }

    return createConnector()
        .stdTestConnection(stdTest)
        .stdAccountList(stdAccountList)
        .stdAccountRead(stdAccountRead)
        .stdAccountDiscoverSchema(stdAccountDiscoverSchema)
}
