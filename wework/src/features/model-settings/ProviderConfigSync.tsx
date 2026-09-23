import { useEffect } from 'react'
import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { reloadProviderFileModels } from './providerConfig'

/** Keep all open workbench windows in sync without persisting resolved credentials. */
export function ProviderConfigSync() {
  useEffect(
    () =>
      subscribeDesktopHostEvents(event => {
        if (event.type === 'modelConfig.changed') void reloadProviderFileModels()
      }),
    []
  )
  return null
}
