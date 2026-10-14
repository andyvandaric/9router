# Phase {{PHASE_NUMBER}}: {{PHASE_TITLE}}

**Parent Plan:** [`index.md`](./index.md)  
**Target Modul / File:** `{{TARGET_FILES}}`  
**Parallel Wave:** {{WAVE_NAME}}  
**Author:** {{AUTHOR_NAME}} & Lead Orchestrator  
**Status:** 🟡 Ready / 🔄 In Progress / ✅ Done ({{COMPLETION_DATETIME}}, Commit: {{COMMIT_HASH}})  
**Completed Date:** {{COMPLETION_DATETIME}} _(format: YYYY-MM-DD HH:MM ±HHMM — waktu lokal penulis + offset, cth. +0700; label zona DILARANG. MANDATORY: query live OS clock FIRST via `date "+%Y-%m-%d %H:%M (UTC%z)"` (POSIX/Git Bash) or `Get-Date -Format "yyyy-MM-dd HH:mm (UTC+7)"` (PowerShell/Windows), then substitute the placeholder — NEVER invent datetime values.)_  
**Created:** {{CREATION_DATETIME}} _(format: YYYY-MM-DD HH:MM (UTC+X) — waktu lokal penulis + offset, cth. 2026-09-17 15:30 (UTC+7). MANDATORY: query live OS clock FIRST via `date "+%Y-%m-%d %H:%M (UTC%z)"` (POSIX/Git Bash) or `Get-Date -Format "yyyy-MM-dd HH:mm (UTC+7)"` (PowerShell/Windows), then substitute the placeholder — NEVER invent datetime values.)_  
**Duration:** {{DURATION}} _(format: Completed − Created otomatis; <1 jam Xm Ys; <1 menit Ys; DRAFT = –)_  

---

## 🎯 1. Objective & Scope

{{OBJECTIVE_DESCRIPTION}}

- **In-Scope**:
  - [ ] {{IN_SCOPE_ITEM_1}}
  - [ ] {{IN_SCOPE_ITEM_2}}
- **Out-of-Scope**:
  - {{OUT_OF_SCOPE_ITEM_1}}

---

## 🏛️ 2. Architectural Design & Implementation Detail

{{ARCHITECTURE_DETAILS}}

Ground-Truth Baseline Evidence (`pre_verification_content`) established in baseline audit [{{AUDIT_DOCUMENT_ID}}]({{RELATIVE_PATH_TO_AUDIT_DOC}}):

1. <Specific gap deficit identified in audit>
2. <AST baseline citation live disk files>

---

## 🎨 3. Visual & Wireframe Rule (CRITICAL HARD RULE)

<!--
PILIH SALAH SATU SESUAI DOMAIN FASE:
- Jika FASE MURNI CLI / Backend / Daemon / Tooling: GUNAKAN KATEGORI A (ASCII Banner & Terminal Stream). DILARANG MEMBUAT MOCKUP KOTAK WEB!
- Jika FASE MEMILIKI Web GUI / Frontend Component: GUNAKAN KATEGORI B (Responsive Screen ASCII Layout).
-->

### [KATEGORI A: Khusus Fitur CLI / Backend / Daemon]

#### 1. ASCII Art Header & Brand Badge
```text
{{ASCII_ART_BANNER}}
```

#### 2. Tampilan Terminal Output Eksekusi Realistis
```text
{{REALISTIC_CLI_TERMINAL_OUTPUT}}
```

### [KATEGORI B: Khusus Fitur Frontend / GUI / Web Component]

#### 1. Layout Desktop (Widescreen 1080p / 1440p)
```text
+--------------------------------------------------------------------------------------------------+
|  {{APP_TITLE}}                                                             [User Profile]        |
+--------------------------------------------------------------------------------------------------+
|  [Sidebar Navigation]  |  [Main Content Container]                                               |
|                        |                                                                         |
|                        |  +-------------------------------------------------------------------+  |
|                        |  | Card Component (W3C Tokens: bg-bg-secondary, border-bg-tertiary)  |  |
|                        |  +-------------------------------------------------------------------+  |
+--------------------------------------------------------------------------------------------------+
```

#### 2. Layout Mobile Responsive (<450px)
```text
+------------------------------------------+
| [=] {{APP_TITLE}}                 [User] |
+------------------------------------------+
| Compact stacked cards                    |
| Touch-friendly buttons (min-h: 44px)     |
+------------------------------------------+
```

---

## 📋 4. Technical Contracts & Data Schemas

> WAJIB diisi untuk fase Wave 1 Contract-First (kontrak beku = SSOT sebelum Wave 2 dibuka).
> Untuk fase Wave 2A/2B: JANGAN ubah signature di bawah — perubahan kontrak = kembali ke Wave 1 (re-freeze + re-approval).

```typescript
// ATAU Go Structs / Rust Structs / JSON Schema
export interface {{CONTRACT_NAME}} {
  id: string;
  name: string;
  status: 'active' | 'pending' | 'disabled';
  createdAt: number;
}
```

---

## 🧪 5. Test Strategy & Assertion Matrix (TDD Red-Green-Refactor)

1. **Langkah 1 (RED)**:
   - Tulis unit test di `{{TEST_FILE_PATH}}` yang merefleksikan perilaku yang diinginkan.
   - Jalankan `{{TEST_COMMAND}}` dan pastikan test GAGAL karena alasan yang tepat.
2. **Langkah 2 (GREEN)**:
   - Tulis implementasi minimal di `{{SOURCE_FILE_PATH}}` agar test lolos.
   - Jalankan `{{TEST_COMMAND}}` dan pastikan 100% PASS.
3. **Langkah 3 (REFACTOR)**:
   - Bersihkan kode, hilangkan duplikasi, pastikan file <300 baris (maks 500 toleransi).
   - Tambahkan skenario regression guard.

---

## 📦 5b. Micro-Chunk Dispatch Units (P9 ceilings — do not exceed)
<!-- P9: ≤4 chunks/phase · ≤2 files/chunk (1 core + 1 test) · 1 domain/chunk · Haiku tier ≤2 files · ≤3 steps · ≤2 min -->
### 📦 Chunk 1: [Component / Domain]
- **Target File(s):** `path/to/file.ext` [NEW/AMEND] & `path/to/file.test.ext` [NEW]
- **Domain:** `<one top-level prefix, e.g. agentic-stack/claude/hooks>`
- **Scope Boundary:** 1 file + 1 test file only

---

## ✅ 6. Definition of Done (DoD) Checklist

- [ ] Unit test ditulis terlebih dahulu dan terbukti gagal sebelum implementasi (TDD RED).
- [ ] Implementasi minimal meluluskan seluruh skenario test (TDD GREEN).
- [ ] File yang disentuh strictly mematuhi batas file air-gapped `{{TARGET_FILES}}`.
- [ ] Linter & Typecheck lulus 0 error (`{{LINTER_COMMAND}}` & `{{TYPECHECK_COMMAND}}`).
- [ ] Final Live E2E Gate (khusus fase penutup / Wave terakhir): lolos 4-layer holistic test di lingkungan teraman (`{{E2E_COMMAND}}`), 0 console errors, DB isolated, bukti tercatat di verifikasi.
- [ ] Berkas `index.md` diperbarui statusnya ke `✅ Done` dengan tanggal dan hash commit.
<!-- ACS workflow v1.6.1+0df9085 -->
<!-- ACS workflow v1.33.0+25c54b5 -->
