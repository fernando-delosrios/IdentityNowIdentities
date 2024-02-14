import {
    logger,
    ConnectorError,
    createConnector,
    StdAccountListHandler,
    StdTestConnectionHandler,
    StdAccountDiscoverSchemaHandler,
    StdEntitlementListHandler,
    Context,
} from '@sailpoint/connector-sdk'
import { SDKClient } from './sdk-client'
import { MergedAccount } from './model/account'
import { UniqueForm } from './model/form'
import { Account, BaseAccount, FormInstanceResponseBeta, IdentityDocument, WorkflowBeta } from 'sailpoint-api-client'
import { Review } from './model/review'
import { Email, ErrorEmail } from './model/email'
import {
    findIdenticalMatch,
    findSimilarMatches,
    getAccountFromIdentity,
    getCurrentSource,
    getEmailWorkflow,
    getIdentities,
    getInputFromDescription,
    getOwnerFromSource,
    MSDAY,
    WORKFLOW_NAME,
} from './utils'

const buildReviewerAccount = (identity: IdentityDocument): MergedAccount => {
    const name = identity.name
    const source = identity.source!.name as string
    return {
        identity: name,
        uuid: name,
        attributes: {
            id: name,
            name,
            source,
            history: [],
            reviews: [],
            status: ['reviewer'],
        },
    }
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

export const merging = async (config: any) => {
    const FORM_NAME = 'Identity Merge'

    const {
        baseurl,
        clientId,
        clientSecret,
        'merging.attributes': attributes,
        'merging.identity_attributes': identity_attributes,
        'merging.reviewer': reviewer,
        'merging.expirationDays': expirationDays,
        'merging.score': score,
        id,
    } = config
    const client = new SDKClient({ baseurl, clientId, clientSecret })
    const source = await getCurrentSource(client, config)

    if (!source) {
        throw new Error('No connector source was found on the tenant.')
    }

    const owner = getOwnerFromSource(source)
    const name = `${id} - ${WORKFLOW_NAME}`
    const workflow = await getEmailWorkflow(client, name, owner)

    if (!workflow) {
        throw new Error('Unable to instantiate email workflow')
    }

    const sendEmail = async (email: Email) => {
        await client.testWorkflow(workflow.id!, email)
    }

    const logErrors = async (workflow: WorkflowBeta | undefined, context: Context, input: any, errors: string[]) => {
        let lines = []
        lines.push(`<p>Context: ${JSON.stringify(context)}</p>`)
        lines.push(`<p>Input: ${JSON.stringify(input)}</p>`)
        lines.push('<p>Errors:</p>')
        lines = [...lines, ...errors]
        const message = lines.map((x) => `<p>${x}</p>`).join('\n')
        const recipient = await client.getIdentity(owner.id!)
        const email = new ErrorEmail(source, recipient!.email!, message)

        await sendEmail(email)
    }

    const getFormName = (identity: IdentityDocument): string => {
        return `${FORM_NAME} - ${identity.name}`
    }

    const processManualReviews = async (
        currentFormInstance: FormInstanceResponseBeta
    ): Promise<{ [key: string]: any }> => {
        let name: string | undefined
        let message: string | undefined
        let state = currentFormInstance.state
        let error: string | undefined

        if (state === 'COMPLETED') {
            const decision = currentFormInstance.formData!['identities'].toString()
            const reviewer = await client.getIdentity(currentFormInstance.recipients![0].id!)
            if (reviewer) {
                const reviewerName = reviewer.displayName ? reviewer.displayName : reviewer.name
                if (decision === UniqueForm.NEW_IDENTITY) {
                    name = currentFormInstance.formInput!.name.toString()
                    message = `New identity approved by ${reviewerName}`
                } else {
                    name = decision
                    const source = currentFormInstance.formInput!.source.toString()
                    message = `Assignment of ${name} from ${source} approved by ${reviewerName}`
                }
            } else {
                error = `Recipient for form not found (${decision})`
            }
        }

        return { name, message, state, error }
    }

    const getReviewers = async (identities: IdentityDocument[]): Promise<IdentityDocument[]> => {
        const reviewerIdentity = identities.find((x) => x.attributes!.uid === reviewer)
        let reviewers: IdentityDocument[] = []
        if (reviewerIdentity) {
            reviewers.push(reviewerIdentity)
        } else {
            const workgroups = await client.listWorkgroups()
            const workgroup = workgroups.find((x) => x.name === reviewer)
            if (workgroup) {
                const members = await client.listWorkgroupMembers(workgroup.id!)
                reviewers = identities.filter((x) => members.find((y) => y.externalId === x.id))
            }
        }

        return reviewers
    }

    //==============================================================================================================

    const stdTest: StdTestConnectionHandler = async (context, input, res) => {
        if (source) {
            logger.info('Test successful!')
            res.send({})
        } else {
            throw new ConnectorError('Unable to connect to IdentityNow! Please check your configuration')
        }
    }

    const stdAccountList: StdAccountListHandler = async (context, input, res) => {
        const accounts: MergedAccount[] = []
        const errors: string[] = []

        // Get identities by status
        const { identities, processedIdentities, unprocessedIdentities } = await getIdentities(client, source)

        // Check and process reviewer configuration
        const reviewerIdentities = await getReviewers(identities)
        if (reviewerIdentities.length === 0) {
            const error = 'No reviewers were found'
            logger.error(error)
            errors.push(error)
            await logErrors(workflow, context, input, errors)
            throw new ConnectorError(
                'Unable to find any reviewer from the list. Please check the values exist and try again.'
            )
        }

        for (const ri of reviewerIdentities) {
            const account = buildReviewerAccount(ri)
            updateAccounts(account, accounts)
        }

        // Get existing accounts
        const processedAccounts: Account[] = await client.listAccountsBySource(source.id!)

        for (const pa of processedAccounts) {
            const account = new MergedAccount(pa)
            updateAccounts(account, accounts)
        }

        // Get current review-related data
        const outstandingReviews: string[] = []
        const forms = await client.listForms()
        const formInstances = await client.listFormInstances()
        const reviews = await client.listEntitlementsBySource(source.id!)

        const firstRun = processedIdentities.length === 0

        // First run processing
        if (firstRun) {
            for (const ui of unprocessedIdentities) {
                const message = 'Found on first run'
                const account = new MergedAccount(ui.attributes!.uid, message, 'initial')

                updateAccounts(account, accounts)
            }
        } else {
            // Process new identities
            for (const ui of unprocessedIdentities) {
                const formName = getFormName(ui)
                const currentReviews = reviews.filter((x) => x.name === formName)
                const currentForm = forms.find((x) => x.name === formName)
                const currentFormInstances = currentForm
                    ? formInstances.filter((x) => currentReviews.find((y) => y.value === x.id))
                    : []

                try {
                    const unprocessedAccount = getAccountFromIdentity(
                        ui,
                        ui.attributes!.cloudAuthoritativeSource
                    ) as BaseAccount
                    // Process existing review
                    if (currentForm && currentFormInstances.length > 0) {
                        let finished = false
                        for (const currentFormInstance of currentFormInstances) {
                            const {
                                name: identityMatchName,
                                message,
                                state,
                                error,
                            } = await processManualReviews(currentFormInstance)

                            if (error) {
                                logger.error(error)
                                errors.push(error)
                            }

                            switch (state) {
                                case 'COMPLETED':
                                    const identityMatch = processedIdentities.find((x) => x.name === identityMatchName)
                                    let account: MergedAccount
                                    if (identityMatch) {
                                        const uniqueAccount = processedAccounts.find(
                                            (x) => x.identityId === identityMatch.id
                                        ) as Account
                                        await client.correlateAccount(identityMatch.id, unprocessedAccount.id!)
                                        account = new MergedAccount(uniqueAccount.name, message, 'manual')
                                    } else {
                                        const uniqueID = ui.attributes!.uid
                                        account = new MergedAccount(uniqueID, message, 'authorized')
                                    }

                                    updateAccounts(account, accounts)
                                    finished = true
                                    break

                                case 'CANCELLED':
                                    logger.info(`${formName} was cancelled`)
                                    finished = true
                                    break

                                default:
                                    logger.info(`No decision made yet for ${formName}`)
                            }

                            if (finished) {
                                try {
                                    logger.info(`Deleting form ${currentForm.name}`)
                                    await client.deleteForm(currentForm.id!)
                                } catch (e) {
                                    const error = `Error deleting form with ID ${currentFormInstance.formDefinitionId}`
                                    logger.error(error)
                                    errors.push(error)
                                }
                                // Add existing reviews as entitlements for reviewers
                            } else {
                                outstandingReviews.push(currentFormInstance.id!)
                            }
                            // No review found so process anew
                        }
                    } else {
                        // Check if form exists before creating a new one
                        if (currentForm) {
                            const error = `${formName} form found without matching form instance. Please aggregate entitlements first or delete the form and try again.`
                            logger.error(error)
                            errors.push(error)
                            continue
                        }

                        // Check if identical match exists
                        const identicalMatch = findIdenticalMatch(ui, processedIdentities, attributes)
                        if (identicalMatch) {
                            const uniqueAccount = processedAccounts.find(
                                (x) => x.identityId === identicalMatch.id
                            ) as Account

                            await client.correlateAccount(identicalMatch.id, unprocessedAccount.id!)
                            const message = 'Identical match found'
                            const account = new MergedAccount(uniqueAccount.name, message, 'auto')
                            updateAccounts(account, accounts)
                            // Check if similar match exists
                        } else {
                            const similarMatches = findSimilarMatches(ui, processedIdentities, attributes, score)
                            // Create form but leave entitlement aggregation create instance and send email notification
                            if (similarMatches.length > 0) {
                                const formAttributes = Array.from(new Set([...attributes, ...identity_attributes]))
                                const formOwner = { id: source.owner.id, type: source.owner.type }
                                const inputForm = new UniqueForm(
                                    formName,
                                    formOwner,
                                    ui,
                                    similarMatches,
                                    formAttributes
                                )
                                const form = await client.createForm(inputForm)

                                // No matching existing identity found
                            } else {
                                const message = 'No matching identity found'
                                const account = new MergedAccount(ui.attributes!.uid, message, 'unmatched')

                                updateAccounts(account, accounts)
                            }
                        }
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        logger.error(e.message)
                        errors.push(e.message)
                    }
                }
            }
        }

        // Add reviewer information and send
        for (const account of accounts) {
            if (reviewerIdentities.find((x) => x.attributes!.uid === account.identity)) {
                account.attributes.reviews = outstandingReviews
            }
            logger.info(account)
            res.send(account)
        }

        // Send errors if any
        if (errors.length > 0) {
            await logErrors(workflow, context, input, errors)
        }
    }

    const stdEntitlementList: StdEntitlementListHandler = async (context, input, res) => {
        logger.info(input)
        const errors: string[] = []
        if (input.type === 'review') {
            // Get identities
            const { identities } = await getIdentities(client, source)

            // Check and process reviewer configuration
            const reviewerIdentities = await getReviewers(identities)

            // Get current review-related data
            const forms = await client.listForms()
            const formInstances = await client.listFormInstances()

            const currentForms = forms.filter((x) => x.name?.startsWith(FORM_NAME))
            const expire = new Date(new Date().valueOf() + MSDAY * expirationDays).toISOString()
            //Process existing forms
            for (const form of currentForms) {
                const formName = form.name!
                let currentFormInstances = formInstances.filter(
                    (x) => x.formDefinitionId === form!.id && !['COMPLETED', 'CANCELLED'].includes(x.state!)
                )
                const formInput = form.formInput?.reduce(getInputFromDescription, {})

                for (const reviewerIdentity of reviewerIdentities) {
                    let currentFormInstance = currentFormInstances.find((x) =>
                        x.recipients?.find((x) => x.id === reviewerIdentity.id)
                    )
                    // Form instance already present
                    if (currentFormInstance) {
                        logger.info(`Previous form instances found for ${formName}`)
                        // Create form instance for new form
                    } else {
                        currentFormInstance = await client.createFormInstance(
                            form.id!,
                            formInput!,
                            [reviewerIdentity.id],
                            source.id!,
                            expire
                        )
                        logger.info(
                            `Form URL for ${reviewerIdentities.map((x) => x.name)}: ${
                                currentFormInstance.standAloneFormUrl
                            }`
                        )
                        // Send notifications
                        logger.info(`Sending email notifications for ${formName}`)
                        const reviewerEmails = [reviewerIdentity.attributes!.email]
                        const email = new Email(reviewerEmails, formName, currentFormInstance)
                        await sendEmail(email)

                        // Create review entitlement
                        const review = new Review(
                            currentFormInstance.id!,
                            formName,
                            formInput!.id,
                            currentFormInstance.standAloneFormUrl!
                        )

                        // Send entitlement
                        logger.info(review)
                        res.send(review)
                    }
                }
            }

            // Send errors if any
            if (errors.length > 0) {
                await logErrors(workflow, context, input, errors)
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
                    name: 'name',
                    description: 'Name',
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
                    description: 'Reviews',
                    type: 'string',
                    multi: true,
                    entitlement: true,
                    schemaObjectType: 'review',
                },
            ],
            displayAttribute: 'name',
            identityAttribute: 'id',
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
