/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import WowoGame from './components/WowoGame';

const App: React.FC = () => {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-8 bg-slate-50 text-slate-900">
      <WowoGame />
    </main>
  );
};

export default App;