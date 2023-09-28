import {
    BaseAccount,
    ConditionEffectBeta,
    CreateFormDefinitionRequestBeta,
    FormConditionBeta,
    FormDefinitionInputBeta,
    FormDefinitionInputBetaTypeEnum,
    FormElementBeta,
    FormOwnerBeta,
    IdentityDocument,
    SourceOwner,
} from 'sailpoint-api-client'

const createFormDefinitionInput = (name: string, description?: string): FormDefinitionInputBeta => {
    const input: FormDefinitionInputBeta = {
        id: name,
        type: FormDefinitionInputBetaTypeEnum.String,
        label: name,
        description,
    }

    return input
}

const createFormDefinitionTextElement = (key: string, label: any): FormElementBeta => {
    const element: FormElementBeta = {
        id: key,
        key,
        elementType: 'TEXT',
        config: {
            label,
        },
    }

    return element
}
type Option = { label: string; value: string; subLabel?: string | null }
const createFormDefinitionSelectElement = (key: string, label: any, options: Option[]): FormElementBeta => {
    const element: FormElementBeta = {
        config: {
            dataSource: {
                config: {
                    options,
                },
                dataSourceType: 'STATIC',
            },
            forceSelect: true as any,
            label,
            maximum: 1 as any,
            required: true as any,
        },
        elementType: 'SELECT',
        id: key,
        key,
        validations: [
            {
                validationType: 'REQUIRED',
            },
        ],
    }

    return element
}

export class Form implements CreateFormDefinitionRequestBeta {
    public static NEW_IDENTITY = '#newIdentity#'
    name: string
    formInput: FormDefinitionInputBeta[] | undefined
    formElements: FormElementBeta[] | undefined
    formConditions: FormConditionBeta[] | undefined
    owner: FormOwnerBeta

    constructor(
        name: string,
        owner: SourceOwner,
        identity: IdentityDocument,
        targets: IdentityDocument[],
        attributes: string[]
    ) {
        this.name = name
        this.owner = owner
        this.formInput = []
        for (const attribute of attributes) {
            for (const target of targets) {
                const name = `${target.id}.${attribute}`
                this.formInput.push(createFormDefinitionInput(name, target.attributes![attribute]))
            }
            const name = `${Form.NEW_IDENTITY}.${attribute}`
            this.formInput.push(createFormDefinitionInput(name, identity.attributes![attribute]))
        }
        this.formInput.push(createFormDefinitionInput('id', identity.id))
        const nativeAccount = identity.accounts!.find(
            (x) => x.source!.id === identity.attributes!.cloudAuthoritativeSource
        ) as BaseAccount
        this.formInput.push(createFormDefinitionInput('account', nativeAccount.name))
        this.formInput.push(createFormDefinitionInput('source', nativeAccount.source?.name))

        const topSection: FormElementBeta = {
            id: 'topSection',
            key: 'topSection',
            elementType: 'SECTION',
            config: {
                alignment: 'CENTER' as any,
                description:
                    'Potentially duplicated identity was found. Please review the list of possible matches from existing identities and select the right one.' as any,
                label: 'Identity merge request' as any,
                labelStyle: 'h2' as any,
                showLabel: true as any,
                formElements: attributes.map((x) => createFormDefinitionTextElement(x, x)),
            },
        }
        const options: Option[] = targets.map((x) => ({
            label: x.displayName ? x.displayName : x.name,
            value: x.id,
        }))
        options.push({ label: 'This is a new identy', value: Form.NEW_IDENTITY })
        const identitiesSection: FormElementBeta = {
            id: 'identitiesSection',
            key: 'identitiesSection',
            elementType: 'SECTION',
            config: {
                alignment: 'CENTER' as any,
                label: 'Existing identities' as any,
                labelStyle: 'h3' as any,
                showLabel: true as any,
                formElements: [createFormDefinitionSelectElement('identities', 'Identities', options)],
            },
        }
        const selectionSection: FormElementBeta = {
            id: 'selectionSection',
            key: 'selectionSection',
            elementType: 'SECTION',
            config: {
                alignment: 'CENTER' as any,
                label: 'Identity details' as any,
                labelStyle: 'h4' as any,
                showLabel: true as any,
                formElements: attributes.map((x) => createFormDefinitionTextElement(`${x}.selected`, x)),
            },
        }

        this.formElements = [topSection, identitiesSection, selectionSection]

        this.formConditions = [
            {
                ruleOperator: 'AND',
                rules: [
                    {
                        sourceType: 'ELEMENT',
                        source: 'identities',
                        operator: 'EQ',
                        valueType: 'STRING',
                        value: Form.NEW_IDENTITY as any,
                    },
                ],
                effects: [
                    {
                        effectType: 'HIDE',
                        config: {
                            element: 'selectionSection' as any,
                        },
                    },
                ],
            },
            {
                ruleOperator: 'AND',
                rules: [
                    {
                        sourceType: 'ELEMENT',
                        source: 'identities',
                        operator: 'EM',
                        valueType: 'STRING',
                        value: null as any,
                    },
                ],
                effects: [
                    {
                        effectType: 'HIDE',
                        config: {
                            element: 'selectionSection' as any,
                        },
                    },
                ],
            },
            {
                ruleOperator: 'AND',
                rules: [
                    {
                        sourceType: 'ELEMENT',
                        source: 'identities',
                        operator: 'NOT_EM',
                        valueType: 'STRING',
                        value: null as any,
                    },
                ],
                effects: attributes.map((x) => ({
                    effectType: 'DISABLE',
                    config: {
                        element: `${x}.selected`,
                    },
                })) as any[],
            },
        ]

        for (const attribute of attributes) {
            this.formConditions.push({
                ruleOperator: 'AND',
                rules: [
                    {
                        sourceType: 'INPUT',
                        source: `${Form.NEW_IDENTITY}.${attribute}`,
                        operator: 'NOT_EM',
                        valueType: 'STRING',
                        value: null as any,
                    },
                ],
                effects: [
                    {
                        effectType: 'SET_DEFAULT_VALUE',
                        config: {
                            defaultValueLabel: `${Form.NEW_IDENTITY}.${attribute}` as any,
                            element: attribute as any,
                        },
                    },
                    {
                        effectType: 'DISABLE',
                        config: {
                            element: attribute as any,
                        },
                    },
                ],
            })
        }
        for (const target of targets) {
            this.formConditions.push({
                ruleOperator: 'AND',
                rules: [
                    {
                        sourceType: 'ELEMENT',
                        source: 'identities',
                        operator: 'EQ',
                        valueType: 'STRING',
                        value: target.id as any,
                    },
                ],
                effects: [
                    {
                        effectType: 'SHOW',
                        config: {
                            element: 'selectionSection' as any,
                        },
                    },
                    ...attributes.map<ConditionEffectBeta>((attribute) => ({
                        effectType: 'SET_DEFAULT_VALUE',
                        config: {
                            defaultValueLabel: `${target.id}.${attribute}` as any,
                            element: `${attribute}.selected` as any,
                        },
                    })),
                ],
            })
        }
    }
}
