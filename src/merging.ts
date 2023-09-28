import {
    logger,
    ConnectorError,
    createConnector,
    StdAccountListHandler,
    StdTestConnectionHandler,
    StdAccountDiscoverSchemaHandler,
    StdAccountDiscoverSchemaOutput,
    StdEntitlementListHandler,
} from '@sailpoint/connector-sdk'
import { lig3 } from './utils/lig'
import { SDKClient } from './sdk-client'
import { MergedAccount } from './model/account'
import { Form } from './model/form'
import {
    Account,
    BaseAccount,
    FormDefinitionInputBeta,
    FormDefinitionResponseBeta,
    FormInstanceResponseBeta,
    IdentityDocument,
    Schema,
    Source,
    WorkflowBeta,
    WorkflowBodyOwnerBeta,
} from 'sailpoint-api-client'
import { EmailWorkflow } from './model/emailWorkflow'
import { Review } from './model/review'
import { Email } from './model/email'

const buildAttributeObject = (
    identity: IdentityDocument,
    attributes: string[]
): {
    [key: string]: any
} => {
    const attributeObject: {
        [key: string]: any
    } = {}
    if (identity.attributes) {
        Object.keys(identity.attributes)
            .filter((x: string) => attributes.includes(x))
            .map((x: string) => (attributeObject[x] = identity.attributes![x]))
    }

    return attributeObject
}

const getAccountFromIdentity = (identity: IdentityDocument, sourceID: string): BaseAccount | undefined => {
    return identity.accounts!.find((x) => x.source!.id === sourceID)
}

const updateAccounts = (account: MergedAccount, accounts: MergedAccount[]) => {
    const existingAccount = accounts.find((x) => x.identity === account.identity)
    if (existingAccount) {
        const status = new Set([
            ...(existingAccount.attributes.status as string[]),
            ...(account.attributes.status as string[]),
        ])
        existingAccount.attributes.status = [...status]

        existingAccount.attributes.history = [
            ...(existingAccount.attributes.history as string[]),
            ...(account.attributes.history as string[]),
        ]
    } else {
        accounts.push(account)
    }
}

const findIdenticalMatch = (
    identity: IdentityDocument,
    candidates: IdentityDocument[],
    attributes: string[]
): IdentityDocument | undefined => {
    let match: IdentityDocument | undefined
    const identityAttributes = buildAttributeObject(identity, attributes)
    const identityStringAttributes = JSON.stringify(identityAttributes)
    const candidatesAttributes = candidates.map((x) => buildAttributeObject(x, attributes))
    const candidatesStringAttributes = candidatesAttributes.map((x) => JSON.stringify(x))

    const firstIndex = candidatesStringAttributes.indexOf(identityStringAttributes)
    const lastIndex = candidatesStringAttributes.lastIndexOf(identityStringAttributes)
    if (firstIndex && firstIndex === lastIndex) {
        match = candidates[firstIndex]
    }

    return match
}

const findSimilarMatches = (
    identity: IdentityDocument,
    candidates: IdentityDocument[],
    attributes: string[],
    score: number
): IdentityDocument[] => {
    const similarMatches: IdentityDocument[] = []
    const length = attributes.length

    for (const candidate of candidates) {
        const scores: number[] = []
        for (const attribute of attributes) {
            const cValue = candidate.attributes![attribute]
            const iValue = identity.attributes![attribute]
            const similarity = lig3(iValue, cValue)
            scores.push(similarity)
        }

        const finalScore =
            scores.reduce((p, c) => {
                return p + c
            }, 0) / length

        if (finalScore * 100 >= score) {
            similarMatches.push(candidate)
        }
    }

    return similarMatches
}

export const merging = async (config: any) => {
    const FORM_NAME = 'Identity Merge'
    const WORKFLOW_NAME = 'Email Sender'
    const MSDAY = 86400000

    const {
        baseurl,
        clientId,
        clientSecret,
        'merging.attributes': attributes,
        'merging.reviewers': reviewers,
        'merging.expirationDays': expirationDays,
        'merging.score': score,
        id,
    } = config
    const client = new SDKClient({ baseurl, clientId, clientSecret })

    const processManualReviews = async (
        currentFormInstance: FormInstanceResponseBeta
    ): Promise<{ [key: string]: any }> => {
        const completedFormInstances: FormInstanceResponseBeta[] = []
        let id: string | undefined
        let message: string | undefined
        let state = currentFormInstance.state

        if (state === 'COMPLETED') {
            const decision = currentFormInstance.formData!['identities'].toString()
            const reviewer = await client.getIdentity(currentFormInstance.recipients![0].id!)
            if (reviewer) {
                const reviewerName = reviewer.displayName ? reviewer.displayName : reviewer.name
                if (decision === Form.NEW_IDENTITY) {
                    id = currentFormInstance.formInput!.id.toString()
                    message = `New identity approved by ${reviewerName}`
                } else {
                    id = decision
                    const account = currentFormInstance.formInput!.account.toString()
                    const source = currentFormInstance.formInput!.source.toString()
                    message = `Assignment of ${account} from ${source} approved by ${reviewerName}`
                }
            } else {
                logger.error(`Recipient for form not found (${decision})`)
            }
        }

        return { id, message, state }
    }

    const getCurrentSource = async (config: any): Promise<Source | undefined> => {
        const sources = (await client.listSources()).find((x) => (x.connectorAttributes as any).id === config.id)

        return sources
    }

    const maintainEmailWorkflow = async (
        name: string,
        owner: WorkflowBodyOwnerBeta
    ): Promise<WorkflowBeta | undefined> => {
        const workflows = await client.listWorkflows()
        let workflow = workflows.find((x) => x.name === name)
        if (!workflow) {
            const emailWorkflow = new EmailWorkflow(name, owner)
            workflow = await client.createWorkflow(emailWorkflow)
        }

        return workflow
    }

    const getIdentities = async (source: Source): Promise<{ [key: string]: IdentityDocument[] }> => {
        const identities = await client.listIdentities()
        const officialIdentities: IdentityDocument[] = []
        const unofficialIdentities: IdentityDocument[] = []
        for (const identity of identities) {
            if (identity.accounts!.find((x) => x.source!.id === source.id)) {
                officialIdentities.push(identity)
            } else if (identity.attributes!.cloudAuthoritativeSource) {
                unofficialIdentities.push(identity)
            }
        }

        return { identities, officialIdentities, unofficialIdentities }
    }

    //==============================================================================================================

    const stdTest: StdTestConnectionHandler = async (context, input, res) => {
        const source = await getCurrentSource(config)
        if (source) {
            const name = `${id} - ${WORKFLOW_NAME}`
            await maintainEmailWorkflow(name, { type: 'IDENTITY', id: source.owner.id })
            logger.info('Test successful!')
            res.send({})
        } else {
            throw new ConnectorError('Unable to connect to IdentityNow! Please check your Username and Password')
        }
    }

    const stdAccountList: StdAccountListHandler = async (context, input, res) => {
        const source = await getCurrentSource(config)
        const accounts: MergedAccount[] = []

        if (!source) {
            throw new Error('No connector source was found on the tenant.')
        }

        const { identities, officialIdentities, unofficialIdentities } = await getIdentities(source)

        const officialAccounts: Account[] = await client.listAccountsBySource(source.id!)

        const reviewerIdentities = identities.filter((x) => reviewers.includes(x.attributes!.uid))
        if (reviewerIdentities.length === 0) {
            logger.error('No reviewers were found')
        } else if (reviewerIdentities.length < reviewers.length) {
            logger.warn('Some reviewers were not found')
        }

        const formInstances = await client.listFormInstances()
        const reviews = await client.listEntitlementsBySource(source.id!)

        for (const oi of officialIdentities) {
            const uniqueAccount = officialAccounts.find((x) => x.identityId === oi.id)
            if (uniqueAccount) {
                const account = new MergedAccount(uniqueAccount)
                accounts.push(account)
            }
        }

        const outstandingReviews: string[] = []
        for (const ui of unofficialIdentities) {
            const formName = `${FORM_NAME} - ${ui.name}`
            const currentReview = reviews.find((x) => x.name === formName)

            if (officialIdentities.length > 0) {
                const unofficialAccount = getAccountFromIdentity(
                    ui,
                    ui.attributes!.cloudAuthoritativeSource
                ) as BaseAccount
                const identicalMatch = findIdenticalMatch(ui, officialIdentities, attributes)

                if (identicalMatch) {
                    const uniqueAccount = officialAccounts.find((x) => x.identityId === identicalMatch.id) as Account

                    await client.correlateAccount(identicalMatch.id, unofficialAccount.id!)
                    const message = 'Identical match found'
                    const account = new MergedAccount(uniqueAccount.name, message, 'auto')
                    updateAccounts(account, accounts)
                    continue
                } else if (currentReview) {
                    const currentFormInstance = formInstances.find((x) => x.formDefinitionId === currentReview.value)
                    let finished = false
                    if (currentFormInstance) {
                        const { id: identityMatchId, message, state } = await processManualReviews(currentFormInstance)
                        if (state === 'COMPLETED') {
                            const identityMatch = officialIdentities.find((x) => x.id === identityMatchId)
                            let account: MergedAccount
                            if (identityMatch) {
                                const uniqueAccount = officialAccounts.find(
                                    (x) => x.identityId === identityMatch.id
                                ) as Account
                                await client.correlateAccount(identityMatch.id, unofficialAccount.id!)
                                account = new MergedAccount(uniqueAccount.name, message, 'manual')
                            } else {
                                const uniqueID = ui.attributes!.uid
                                account = new MergedAccount(uniqueID, message, 'authorized')
                            }

                            updateAccounts(account, accounts)
                            finished = true
                        } else if (state === 'CANCELLED') {
                            logger.info(`${formName} was cancelled`)
                            finished = true
                        } else if (state === 'ASSIGNED') {
                            logger.info(`Sending email notifications for ${formName}`)
                            const reviewerEmails = reviewerIdentities.map((x) => x.attributes!.email) as string[]
                            const name = `${id} - ${WORKFLOW_NAME}`
                            const workflow = await maintainEmailWorkflow(name, {
                                type: 'IDENTITY',
                                id: source.owner.id,
                            })
                            if (workflow) {
                                const email = new Email(reviewerEmails, formName, currentFormInstance)
                                await client.testWorkflow(workflow.id!, email)

                                await client.setFormInstanceState(currentFormInstance.id!, 'IN_PROGRESS')
                            }
                        } else {
                            logger.info(`No decision made yet for ${formName}`)
                        }

                        if (finished) {
                            try {
                                await client.deleteForm(currentReview!.value!)
                            } catch (e) {
                                logger.error(`Error deleting form with ID ${currentReview!.value!}`)
                            }
                        } else {
                            outstandingReviews.push(currentReview.value!)
                        }
                    }
                }
            } else {
                const message = 'Found on first run'
                const account = new MergedAccount(ui.attributes!.uid, message, 'initial')

                updateAccounts(account, accounts)
            }
        }

        for (const account of accounts) {
            if (reviewers.includes(account.identity)) {
                account.attributes.reviews = outstandingReviews
            }
            logger.info(account)
            res.send(account)
        }
    }

    const stdEntitlementList: StdEntitlementListHandler = async (context, input, res) => {
        const source = await getCurrentSource(config)

        if (!source) {
            throw new Error('No connector source was found on the tenant.')
        }

        const { identities, officialIdentities, unofficialIdentities } = await getIdentities(source)

        const reviewerIdentities = identities.filter((x) => reviewers.includes(x.attributes!.uid))

        if (officialIdentities.length > 0 && reviewerIdentities.length > 0) {
            const getInputFromDescription = (
                p: { [key: string]: string },
                c: FormDefinitionInputBeta
            ): { [key: string]: string } => {
                p[c.id!] = c.description!
                return p
            }
            const formOwner = { id: source.owner.id, type: source.owner.type }
            const expire = new Date(new Date().valueOf() + MSDAY * expirationDays).toISOString()
            const forms = await client.listForms()

            const formInstances = await client.listFormInstances()

            let form: FormDefinitionResponseBeta | undefined
            for (const ui of unofficialIdentities) {
                let currentFormInstance: FormInstanceResponseBeta | undefined
                const formName = `${FORM_NAME} - ${ui.name}`
                form = forms.find((x) => x.name! === formName)
                if (form) {
                    currentFormInstance = formInstances.find(
                        (x) => x.formDefinitionId === form!.id && !['COMPLETED', 'CANCELLED'].includes(x.state!)
                    )
                } else {
                    const similarMatches = findSimilarMatches(ui, officialIdentities, attributes, score)
                    if (similarMatches.length === 0) {
                        continue
                    }
                    const inputForm = new Form(formName, formOwner, ui, similarMatches, attributes)
                    form = await client.createForm(inputForm)
                }

                if (currentFormInstance) {
                    logger.info(`Previous form instance found for ${formName}`)
                } else {
                    const formInput = form.formInput?.reduce(getInputFromDescription, {})
                    currentFormInstance = await client.createFormInstance(
                        form.id!,
                        formInput!,
                        reviewerIdentities.map((x) => x.id),
                        source.id!,
                        expire
                    )
                    logger.info(
                        `Form URL for ${reviewerIdentities.map((x) => x.name)}: ${
                            currentFormInstance.standAloneFormUrl
                        }`
                    )
                }

                const review = new Review(
                    currentFormInstance.formDefinitionId!,
                    formName,
                    ui.attributes!.uid,
                    currentFormInstance.standAloneFormUrl!
                )

                logger.info(review)
                res.send(review)
            }
        }
    }

    const stdAccountDiscoverSchema: StdAccountDiscoverSchemaHandler = async (context, input, res) => {
        const schema: any = {
            attributes: [
                {
                    name: 'id',
                    description: 'ID',
                    type: 'string',
                },
                {
                    name: 'history',
                    description: 'History',
                    type: 'string',
                    multi: true,
                },
                {
                    name: 'status',
                    description: 'Status',
                    type: 'string',
                    multi: true,
                    entitlement: true,
                },
                {
                    name: 'reviews',
                    description: 'Status',
                    type: 'string',
                    multi: true,
                    entitlement: true,
                    schemaObjectType: 'review',
                },
            ],
            displayAttribute: 'id',
            identityAttribute: 'id',
            // groupAttribute: 'reviews',
        }

        logger.info(schema)
        res.send(schema)
    }

    return createConnector()
        .stdTestConnection(stdTest)
        .stdAccountList(stdAccountList)
        .stdEntitlementList(stdEntitlementList)
        .stdAccountDiscoverSchema(stdAccountDiscoverSchema)
}
