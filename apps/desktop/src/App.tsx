import { useEffect, useState } from 'react'
import { api } from '@/api'
import { Spinner } from '@/components/ui'
import { Advanced } from '@/advanced/Advanced'
import { Onboarding } from '@/onboarding/Onboarding'

// Setup opens on its own until megabrain has been installed once on this machine; the CLI's install
// state says so (`previous` in the install plan), not anything the app keeps.
export function App() {
  const [screen, setScreen] = useState<'loading' | 'setup' | 'home'>('loading')

  useEffect(() => {
    api.installPlan().then(
      (plan) => setScreen(plan.previous === null ? 'setup' : 'home'),
      () => setScreen('setup'),
    )
  }, [])

  if (screen === 'loading')
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  if (screen === 'setup') return <Onboarding onFinish={() => setScreen('home')} />
  return <Advanced onSetup={() => setScreen('setup')} />
}
