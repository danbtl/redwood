import path from 'path'

import { vi, beforeAll, afterAll, test, expect } from 'vitest'

import {
  LAMBDA_FUNCTIONS,
  loadFunctionsFromDist,
} from '../plugins/lambdaLoader'

// Suppress terminal logging.
console.log = vi.fn()

// Set up RWJS_CWD.
let original_RWJS_CWD: string | undefined

beforeAll(() => {
  original_RWJS_CWD = process.env.RWJS_CWD
  process.env.RWJS_CWD = path.resolve(
    __dirname,
    'fixtures/redwood-app-number-functions'
  )
})

afterAll(() => {
  process.env.RWJS_CWD = original_RWJS_CWD
})

test('loadFunctionsFromDist puts functions named with numbers before the graphql function', async () => {
  expect(LAMBDA_FUNCTIONS).toEqual({})

  await loadFunctionsFromDist()

  expect(Object.keys(LAMBDA_FUNCTIONS)[0]).toEqual('1')
})
