/**
 * @license React
 * react-server-dom-webpack-node-loader.production.min.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copied from https://github.com/facebook/react/blob/8ec962d825fc948ffda5ab863e639cd4158935ba/packages/react-server-dom-webpack/src/ReactFlightWebpackNodeLoader.js
// and converted to TypeScript.

import path from 'node:path'

import * as acorn from 'acorn-loose'

import { getPaths } from '@redwoodjs/project-config'

interface ResolveContext {
  parentURL: string | void
  conditions: Array<string>
}

export type ResolveFunction = (
  specifier: string,
  context: ResolveContext,
  resolveFunction: ResolveFunction
) => { url: string } | Promise<{ url: string }>

interface GetSourceContext {
  format: string
}

type GetSourceFunction = (
  url: string,
  context: GetSourceContext,
  getSourceFunction: GetSourceFunction
) => Promise<{ source: Source }>

interface TransformSourceContext {
  format: string
  url: string
}

type TransformSourceFunction = (
  source: Source,
  context: TransformSourceContext,
  transformSourceFunction: TransformSourceFunction
) => Promise<{ source: Source }>

interface LoadContext {
  conditions: Array<string>
  format: string | null | void
  importAssertions: object
}

type LoadFunction = (
  url: string,
  loadContext: LoadContext | null,
  loadFunction: LoadFunction
) => Promise<{ format: string; shortCircuit?: boolean; source: Source }>

// This is the official type, but the code below throws if it isn't a string.
// Tightening the type to string is required for interop with Vite (Rollup).
// type Source = string | ArrayBuffer | Uint8Array
type Source = string

let warnedAboutConditionsFlag = false

let stashedGetSource: null | GetSourceFunction = null
let stashedResolve: null | ResolveFunction = null

export async function resolve(
  specifier: string,
  context: ResolveContext,
  defaultResolve: ResolveFunction
): Promise<{ url: string }> {
  // We stash this in case we end up needing to resolve export * statements later.
  stashedResolve = defaultResolve

  if (!context.conditions.includes('react-server')) {
    context = {
      ...context,
      conditions: [...context.conditions, 'react-server'],
    }

    if (!warnedAboutConditionsFlag) {
      warnedAboutConditionsFlag = true

      console.warn(
        'You did not run Node.js with the `--conditions react-server` flag. ' +
          'Any "react-server" override will only work with ESM imports.'
      )
    }
  }

  return await defaultResolve(specifier, context, defaultResolve)
}

export async function getSource(
  url: string,
  context: GetSourceContext,
  defaultGetSource: GetSourceFunction
): Promise<{ source: Source }> {
  // We stash this in case we end up needing to resolve export * statements later.
  stashedGetSource = defaultGetSource
  return defaultGetSource(url, context, defaultGetSource)
}

function addLocalExportedNames(names: Map<string, string>, node: any) {
  switch (node.type) {
    case 'Identifier':
      names.set(node.name, node.name)
      return

    case 'ObjectPattern':
      for (let i = 0; i < node.properties.length; i++) {
        addLocalExportedNames(names, node.properties[i])
      }

      return

    case 'ArrayPattern':
      for (let i = 0; i < node.elements.length; i++) {
        const element = node.elements[i]
        if (element) {
          addLocalExportedNames(names, element)
        }
      }

      return

    case 'Property':
      addLocalExportedNames(names, node.value)
      return

    case 'AssignmentPattern':
      addLocalExportedNames(names, node.left)
      return

    case 'RestElement':
      addLocalExportedNames(names, node.argument)
      return

    case 'ParenthesizedExpression':
      addLocalExportedNames(names, node.expression)
      return
  }
}

function transformServerModule(
  source: string,
  body: any,
  url: string,
  _loader?: LoadFunction
): string {
  // If the same local name is exported more than once, we only need one of the names.
  const localNames = new Map()
  const localTypes = new Map()

  for (let i = 0; i < body.length; i++) {
    const node = body[i]

    switch (node.type) {
      case 'ExportAllDeclaration':
        // If export * is used, the other file needs to explicitly opt into "use server" too.
        break

      case 'ExportDefaultDeclaration':
        if (node.declaration.type === 'Identifier') {
          localNames.set(node.declaration.name, 'default')
        } else if (node.declaration.type === 'FunctionDeclaration') {
          if (node.declaration.id) {
            localNames.set(node.declaration.id.name, 'default')
            localTypes.set(node.declaration.id.name, 'function')
          }
        }

        continue

      case 'ExportNamedDeclaration':
        if (node.declaration) {
          if (node.declaration.type === 'VariableDeclaration') {
            const declarations = node.declaration.declarations

            for (let j = 0; j < declarations.length; j++) {
              addLocalExportedNames(localNames, declarations[j].id)
            }
          } else {
            const name = node.declaration.id.name
            localNames.set(name, name)

            if (node.declaration.type === 'FunctionDeclaration') {
              localTypes.set(name, 'function')
            }
          }
        }

        if (node.specifiers) {
          const specifiers = node.specifiers

          for (let j = 0; j < specifiers.length; j++) {
            const specifier = specifiers[j]
            localNames.set(specifier.local.name, specifier.exported.name)
          }
        }

        continue
    }
  }

  let newSrc = source + '\n\n;'
  localNames.forEach(function (exported, local) {
    if (localTypes.get(local) !== 'function') {
      // We first check if the export is a function and if so annotate it.
      newSrc += 'if (typeof ' + local + ' === "function") '
    }

    newSrc += 'Object.defineProperties(' + local + ',{'
    newSrc += '$$typeof: {value: Symbol.for("react.server.reference")},'
    newSrc += '$$id: {value: ' + JSON.stringify(url + '#' + exported) + '},'
    newSrc += '$$bound: { value: null }'
    newSrc += '});\n'
  })

  return newSrc
}

function addExportNames(names: Array<string>, node: any) {
  switch (node.type) {
    case 'Identifier':
      names.push(node.name)
      return

    case 'ObjectPattern':
      for (let i = 0; i < node.properties.length; i++) {
        addExportNames(names, node.properties[i])
      }

      return

    case 'ArrayPattern':
      for (let i = 0; i < node.elements.length; i++) {
        const element = node.elements[i]
        if (element) {
          addExportNames(names, element)
        }
      }

      return

    case 'Property':
      addExportNames(names, node.value)
      return

    case 'AssignmentPattern':
      addExportNames(names, node.left)
      return

    case 'RestElement':
      addExportNames(names, node.argument)
      return

    case 'ParenthesizedExpression':
      addExportNames(names, node.expression)
      return
  }
}

function resolveClientImport(
  specifier: string,
  parentURL: string
): { url: string } | Promise<{ url: string }> {
  // Resolve an import specifier as if it was loaded by the client. This doesn't use
  // the overrides that this loader does but instead reverts to the default.
  // This resolution algorithm will not necessarily have the same configuration
  // as the actual client loader. It should mostly work and if it doesn't you can
  // always convert to explicit exported names instead.

  if (stashedResolve === null) {
    throw new Error(
      'Expected resolve to have been called before transformSource'
    )
  }

  return stashedResolve(
    specifier,
    {
      conditions: ['node', 'import'],
      parentURL,
    },
    stashedResolve
  )
}

/**
 * Parses `body` for exports and stores them in `names` (the second argument)
 */
async function parseExportNamesIntoNames(
  body: any,
  names: Array<string>,
  parentURL: string,
  loader: LoadFunction
): Promise<void> {
  for (let i = 0; i < body.length; i++) {
    const node = body[i]

    switch (node.type) {
      case 'ExportAllDeclaration':
        if (node.exported) {
          addExportNames(names, node.exported)
          continue
        } else {
          const clientImport = await resolveClientImport(
            node.source.value,
            parentURL
          )
          const url = clientImport.url
          const loadContext = {
            format: 'module',
            conditions: [],
            importAssertions: {},
          }
          const mod = await loader(url, loadContext, loader)

          if (typeof mod.source !== 'string') {
            throw new Error('Expected the transformed source to be a string.')
          }

          let childBody

          try {
            childBody = acorn.parse(mod.source, {
              ecmaVersion: '2024',
              sourceType: 'module',
            }).body
          } catch (x: any) {
            console.error('Error parsing %s %s', url, x.message)
            continue
          }

          await parseExportNamesIntoNames(childBody, names, url, loader)

          continue
        }

      case 'ExportDefaultDeclaration':
        names.push('default')
        continue

      case 'ExportNamedDeclaration':
        if (node.declaration) {
          if (node.declaration.type === 'VariableDeclaration') {
            const declarations = node.declaration.declarations

            for (let j = 0; j < declarations.length; j++) {
              addExportNames(names, declarations[j].id)
            }
          } else {
            addExportNames(names, node.declaration.id)
          }
        }

        if (node.specifiers) {
          const specifiers = node.specifiers

          for (let j = 0; j < specifiers.length; j++) {
            addExportNames(names, specifiers[j].exported)
          }
        }

        continue
    }
  }
}

async function transformClientModule(
  body: any,
  url: string,
  loader: LoadFunction,
  clientEntryFiles?: Record<string, string>
): Promise<string> {
  const names: Array<string> = []

  // This will insert the names into the `names` array
  await parseExportNamesIntoNames(body, names, url, loader)

  const entryRecord = Object.entries(clientEntryFiles || {}).find(
    ([_key, value]) => value === url
  )

  // TODO (RSC): Check if we always find a record. If we do, we should
  // throw an error if it's undefined

  const loadId = entryRecord
    ? path.join(getPaths().web.distServer, 'assets', entryRecord[0] + '.js')
    : url

  let newSrc =
    "const CLIENT_REFERENCE = Symbol.for('react.client.reference');\n"

  for (let i = 0; i < names.length; i++) {
    const name = names[i]

    if (name === 'default') {
      newSrc += 'export default '
      newSrc += 'Object.defineProperties(function() {'
      newSrc +=
        'throw new Error(' +
        JSON.stringify(
          'Attempted to call the default export of ' +
            url +
            ' from the server' +
            "but it's on the client. It's not possible to invoke a client function from " +
            'the server, it can only be rendered as a Component or passed to props of a' +
            'Client Component.'
        ) +
        ');'
    } else {
      newSrc += 'export const ' + name + ' = '
      newSrc += 'Object.defineProperties(function() {'
      newSrc +=
        'throw new Error(' +
        JSON.stringify(
          'Attempted to call ' +
            name +
            '() from the server but ' +
            name +
            ' is on the client. ' +
            "It's not possible to invoke a client function from the server, it can " +
            'only be rendered as a Component or passed to props of a Client Component.'
        ) +
        ');'
    }

    newSrc += '},{'
    newSrc += '$$typeof: {value: CLIENT_REFERENCE},'
    newSrc += '$$id: {value: ' + JSON.stringify(loadId + '#' + name) + '}'
    newSrc += '});\n'
  }

  return newSrc
}

async function loadClientImport(
  url: string,
  defaultTransformSource: TransformSourceFunction
): Promise<{ format: string; shortCircuit?: boolean; source: Source }> {
  if (stashedGetSource === null) {
    throw new Error(
      'Expected getSource to have been called before transformSource'
    )
  }

  // TODO: Validate that this is another module by calling getFormat.

  const getSourceContext = { format: 'module' }
  const { source } = await stashedGetSource(
    url,
    getSourceContext,
    stashedGetSource
  )
  const transformContext = {
    format: 'module',
    url,
  }
  const { source: transformedSource } = await defaultTransformSource(
    source,
    transformContext,
    defaultTransformSource
  )

  return { format: 'module', source: transformedSource }
}

async function transformModuleIfNeeded(
  source: string,
  url: string,
  loader: LoadFunction,
  clientEntryFile?: Record<string, string>
): Promise<string> {
  // Do a quick check for the exact string. If it doesn't exist, don't
  // bother parsing.
  if (!source.includes('use client') && !source.includes('use server')) {
    return source
  }

  let body

  try {
    body = acorn.parse(source, {
      ecmaVersion: '2024',
      sourceType: 'module',
    }).body
  } catch (x: any) {
    console.error('Error parsing %s %s', url, x.message)
    return source
  }

  let useClient = false
  let useServer = false

  for (let i = 0; i < body.length; i++) {
    const node = body[i]

    if (node.type !== 'ExpressionStatement' || !node.directive) {
      break
    }

    if (node.directive === 'use client') {
      useClient = true
    }

    if (node.directive === 'use server') {
      useServer = true
    }
  }

  if (!useClient && !useServer) {
    return source
  }

  if (useClient && useServer) {
    throw new Error(
      'Cannot have both "use client" and "use server" directives in the same file.'
    )
  }

  if (useClient) {
    return transformClientModule(body, url, loader, clientEntryFile)
  }

  return transformServerModule(source, body, url)
}

export async function transformSource(
  source: Source,
  context: TransformSourceContext,
  defaultTransformSource: TransformSourceFunction
): Promise<{ source: Source }> {
  const transformed = await defaultTransformSource(
    source,
    context,
    defaultTransformSource
  )

  if (context.format === 'module') {
    const transformedSource = transformed.source

    if (typeof transformedSource !== 'string') {
      throw new Error('Expected source to have been transformed to a string.')
    }

    const newSrc = await transformModuleIfNeeded(
      transformedSource,
      context.url,
      (url: string) => {
        return loadClientImport(url, defaultTransformSource)
      }
    )

    return { source: newSrc }
  }

  return transformed
}

export async function load(
  url: string,
  context: LoadContext | null,
  defaultLoad: LoadFunction,
  clientEntryFiles?: Record<string, string>
): Promise<{ format: string; shortCircuit?: boolean; source: Source }> {
  const result = await defaultLoad(url, context, defaultLoad)

  if (result.format === 'module') {
    if (typeof result.source !== 'string') {
      throw new Error('Expected source to have been loaded into a string.')
    }

    const newSrc = await transformModuleIfNeeded(
      result.source,
      url,
      defaultLoad,
      clientEntryFiles
    )

    return {
      format: 'module',
      source: newSrc,
    }
  }

  return result
}
