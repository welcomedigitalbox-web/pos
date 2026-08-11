# POS MVP — Next.js + Supabase

## Local development

```bash
npm install
npm run dev
```
`http://localhost:3000` ကို browser နဲ့ ဖွင့်ပါ.

## Environment variables

`.env.local` ဖိုင် (ဒီ project ထဲ ရှိပြီးသား, Kay ရဲ့ Supabase project နဲ့ ချိတ်ထားပြီးသား):
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```
⚠️ ဒီဖိုင်ကို git ထဲ commit **မလုပ်ပါနဲ့** — `.gitignore` ထဲ default ပါပြီးသားပါတယ်။

## GitHub ကို push လုပ်ခြင်း

1. github.com → **New repository** ဖန်တီးပါ (public ဒါမှမဟုတ် private, README/gitignore မထည့်ပါနဲ့ — local ကနေ ရှိပြီးသား)
2. Local project ကို GitHub ချိတ်ပါ:
```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

## Vercel ကို Deploy လုပ်ခြင်း

1. vercel.com → GitHub account နဲ့ login
2. **Add New Project** → GitHub repo ကို ရွေးပါ
3. **Environment Variables** section မှာ ဒီ ၂ ခု ထည့်ပါ:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. **Deploy** နှိပ်ပါ — 1-2 မိနစ်အတွင်း live URL ရမယ်

## Project structure

```
pos-app/
├── app/
│   ├── page.tsx           # POS main screen (product grid + cart)
│   ├── history/page.tsx   # Sale history
│   ├── dashboard/page.tsx # Today's summary dashboard
│   ├── nav.tsx             # Top nav + store selector
│   ├── store-context.tsx   # Selected store (branch) state
│   └── layout.tsx
├── lib/
│   └── supabase.ts        # Supabase client + types
└── .env.local              # Supabase credentials (git-ignored)
```

## Database

`schema.sql` ကို Supabase SQL Editor မှာ run ပြီးသား ဆိုရင် skip ပါ။ Run မလုပ်ရသေးရင် Supabase dashboard → SQL Editor မှာ run ပါ.

## Next steps (Phase 1 core ပြီးရင်)

- [ ] Authentication (cashier login)
- [ ] Product management screen (add/edit/delete)
- [ ] Costing/COGS (Moving Weighted Average)
- [ ] Role-based access (RLS policy ကို "public access" ကနေ role-based ပြောင်း)
- [ ] Real product data import (Excel)
