#include <emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/heap.h>
#include <stdio.h>
#include <string.h>
#include <sys/sysinfo.h>
#include "../../../Common/MyInitGuid.h"
#include "../../../Common/MyCom.h"
#include "../../../Common/MyString.h"
#include "../../Archive/IArchive.h"
#include "../../Archive/7z/7zHandler.h"
#include "../../../Windows/PropVariant.h"

using namespace NArchive;

// 7-Zip 26.03 queries host RAM even in the single-threaded build. Emscripten
// declares sysinfo() but does not provide it, so report the actual Wasm heap.
extern "C" int sysinfo(struct sysinfo *info) {
  if (!info) return -1;
  memset(info, 0, sizeof(*info));
  info->mem_unit = 1;
  info->totalram = (unsigned long)emscripten_get_heap_size();
  info->freeram = info->totalram;
  return 0;
}

// Alone2 retains its console wrapper in 26.03. The direct module has no CLI;
// satisfy that unreachable wrapper without reintroducing callMain().
int Main2(int, char **) { return 0; }

EM_JS(int, js_read, (int id, unsigned char *p, int n), {
  const f = Module['stream7zRead'];
  if (typeof f !== 'function') return -1;
  return f(id, HEAPU8.subarray(p, p + n)) | 0;
});
EM_JS(int, js_read_at, (int id, double pos, unsigned char *p, int n), {
  const f = Module['stream7zReadAt'];
  if (typeof f !== 'function') return -1;
  return f(id, pos, HEAPU8.subarray(p, p + n)) | 0;
});
EM_JS(int, js_write_at, (int id, double pos, const unsigned char *p, int n), {
  const f = Module['stream7zWriteAt'];
  if (typeof f !== 'function') return -1;
  return f(id, pos, HEAPU8.subarray(p, p + n)) | 0;
});
EM_JS(int, js_set_size, (int id, double size), {
  const f = Module['stream7zSetSize'];
  if (typeof f !== 'function') return -1;
  return f(id, size) | 0;
});
EM_JS(double, js_heap_size, (), { return HEAPU8.buffer.byteLength; });

static char g_error[512];

class CJsInStream Z7_final: public ISequentialInStream, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_1(ISequentialInStream)
  Z7_IFACE_COM7_IMP(ISequentialInStream)
public:
  int Id;
  explicit CJsInStream(int id): Id(id) {}
};
Z7_COM7F_IMF(CJsInStream::Read(void *data, UInt32 size, UInt32 *processedSize)) {
  const int n = js_read(Id, (unsigned char *)data, (int)size);
  if (n < 0) return E_FAIL;
  if (processedSize) *processedSize = (UInt32)n;
  return S_OK;
}

class CJsSeekInStream Z7_final: public IInStream, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_2(ISequentialInStream, IInStream)
  Z7_IFACE_COM7_IMP(ISequentialInStream)
  Z7_IFACE_COM7_IMP(IInStream)
public:
  int Id;
  UInt64 Pos;
  UInt64 Size;
  CJsSeekInStream(int id, UInt64 size): Id(id), Pos(0), Size(size) {}
};
Z7_COM7F_IMF(CJsSeekInStream::Read(void *data, UInt32 size, UInt32 *processedSize)) {
  const UInt64 remaining = Pos < Size ? Size - Pos : 0;
  const UInt32 wanted = remaining < size ? (UInt32)remaining : size;
  const int n = js_read_at(Id, (double)Pos, (unsigned char *)data, (int)wanted);
  if (n < 0) return E_FAIL;
  Pos += (UInt32)n;
  if (processedSize) *processedSize = (UInt32)n;
  return S_OK;
}
Z7_COM7F_IMF(CJsSeekInStream::Seek(Int64 offset, UInt32 origin, UInt64 *newPosition)) {
  Int64 base;
  if (origin == STREAM_SEEK_SET) base = 0;
  else if (origin == STREAM_SEEK_CUR) base = (Int64)Pos;
  else if (origin == STREAM_SEEK_END) base = (Int64)Size;
  else return STG_E_INVALIDFUNCTION;
  const Int64 next = base + offset;
  if (next < 0) return HRESULT_WIN32_ERROR_NEGATIVE_SEEK;
  Pos = (UInt64)next;
  if (newPosition) *newPosition = Pos;
  return S_OK;
}

class CJsOutStream Z7_final: public IOutStream, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_2(ISequentialOutStream, IOutStream)
  Z7_IFACE_COM7_IMP(ISequentialOutStream)
  Z7_IFACE_COM7_IMP(IOutStream)
public:
  int Id;
  UInt64 Pos;
  UInt64 Size;
  explicit CJsOutStream(int id): Id(id), Pos(0), Size(0) {}
};
Z7_COM7F_IMF(CJsOutStream::Write(const void *data, UInt32 size, UInt32 *processedSize)) {
  const int n = js_write_at(Id, (double)Pos, (const unsigned char *)data, (int)size);
  if (n < 0 || (UInt32)n != size) return E_FAIL;
  Pos += (UInt32)n;
  if (Pos > Size) Size = Pos;
  if (processedSize) *processedSize = (UInt32)n;
  return S_OK;
}
Z7_COM7F_IMF(CJsOutStream::Seek(Int64 offset, UInt32 origin, UInt64 *newPosition)) {
  Int64 base;
  if (origin == STREAM_SEEK_SET) base = 0;
  else if (origin == STREAM_SEEK_CUR) base = (Int64)Pos;
  else if (origin == STREAM_SEEK_END) base = (Int64)Size;
  else return STG_E_INVALIDFUNCTION;
  const Int64 next = base + offset;
  if (next < 0) return HRESULT_WIN32_ERROR_NEGATIVE_SEEK;
  Pos = (UInt64)next;
  if (newPosition) *newPosition = Pos;
  return S_OK;
}
Z7_COM7F_IMF(CJsOutStream::SetSize(UInt64 newSize)) {
  if (js_set_size(Id, (double)newSize) != 0) return E_FAIL;
  Size = newSize;
  if (Pos > Size) Pos = Size;
  return S_OK;
}

class CUpdateCallback Z7_final: public IArchiveUpdateCallback, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_2(IArchiveUpdateCallback, IProgress)
  Z7_IFACE_COM7_IMP(IProgress)
  Z7_IFACE_COM7_IMP(IArchiveUpdateCallback)
public:
  int SourceId;
  UString Name;
  UInt64 Size;
  CUpdateCallback(int sourceId, const wchar_t *name, UInt64 size):
    SourceId(sourceId), Name(name), Size(size) {}
};
Z7_COM7F_IMF(CUpdateCallback::SetTotal(UInt64)) { return S_OK; }
Z7_COM7F_IMF(CUpdateCallback::SetCompleted(const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(CUpdateCallback::GetUpdateItemInfo(
    UInt32, Int32 *newData, Int32 *newProps, UInt32 *indexInArchive)) {
  if (newData) *newData = 1;
  if (newProps) *newProps = 1;
  if (indexInArchive) *indexInArchive = (UInt32)(Int32)-1;
  return S_OK;
}
Z7_COM7F_IMF(CUpdateCallback::GetProperty(UInt32, PROPID propID, PROPVARIANT *value)) {
  NWindows::NCOM::CPropVariant prop;
  switch (propID) {
    case kpidPath: prop = Name; break;
    case kpidIsDir: prop = false; break;
    case kpidSize: prop = Size; break;
    case kpidAttrib: prop = (UInt32)0; break;
    case kpidIsAnti: prop = false; break;
  }
  prop.Detach(value);
  return S_OK;
}
Z7_COM7F_IMF(CUpdateCallback::GetStream(UInt32, ISequentialInStream **inStream)) {
  CMyComPtr<ISequentialInStream> stream = new CJsInStream(SourceId);
  *inStream = stream.Detach();
  return S_OK;
}
Z7_COM7F_IMF(CUpdateCallback::SetOperationResult(Int32 result)) {
  return result == NUpdate::NOperationResult::kOK ? S_OK : E_FAIL;
}

class CExtractCallback Z7_final: public IArchiveExtractCallback, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_2(IArchiveExtractCallback, IProgress)
  Z7_IFACE_COM7_IMP(IProgress)
  Z7_IFACE_COM7_IMP(IArchiveExtractCallback)
public:
  int OutputId;
  CMyComPtr<ISequentialOutStream> Out;
  explicit CExtractCallback(int outputId): OutputId(outputId) {}
};
Z7_COM7F_IMF(CExtractCallback::SetTotal(UInt64)) { return S_OK; }
Z7_COM7F_IMF(CExtractCallback::SetCompleted(const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(CExtractCallback::GetStream(UInt32, ISequentialOutStream **outStream, Int32 askExtractMode)) {
  if (askExtractMode != NArchive::NExtract::NAskMode::kExtract) {
    *outStream = NULL;
    return S_OK;
  }
  Out = new CJsOutStream(OutputId);
  *outStream = Out;
  if (*outStream) (*outStream)->AddRef();
  return S_OK;
}
Z7_COM7F_IMF(CExtractCallback::PrepareOperation(Int32)) { return S_OK; }
Z7_COM7F_IMF(CExtractCallback::SetOperationResult(Int32 resultEOperationResult)) {
  return resultEOperationResult == NArchive::NExtract::NOperationResult::kOK ? S_OK : E_FAIL;
}

static UString AsciiName(const char *s) {
  UString out;
  while (*s) {
    const unsigned char c = (unsigned char)*s++;
    if (c >= 0x80) return UString();
    out.Add_Char((wchar_t)c);
  }
  return out;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE const char *stream7z_last_error() { return g_error; }
EMSCRIPTEN_KEEPALIVE double stream7z_heap_size() { return js_heap_size(); }

EMSCRIPTEN_KEEPALIVE
int stream7z_create(int sourceId, int outputId, const char *memberName, double sizeDouble) {
  g_error[0] = 0;
  if (!memberName || sizeDouble < 0 || sizeDouble > 9007199254740991.0) {
    snprintf(g_error, sizeof(g_error), "invalid arguments");
    return -1;
  }
  const UInt64 size = (UInt64)sizeDouble;
  if ((double)size != sizeDouble) {
    snprintf(g_error, sizeof(g_error), "size must be an integer");
    return -1;
  }
  const UString name = AsciiName(memberName);
  if (name.IsEmpty() && memberName[0]) {
    snprintf(g_error, sizeof(g_error), "member name must be ASCII");
    return -1;
  }

  NArchive::N7z::CHandler *handlerSpec = new NArchive::N7z::CHandler;
  CMyComPtr<IOutArchive> archive = handlerSpec;
  const wchar_t *names[] = { L"x", L"0", L"s", L"tm", L"tr" };
  NWindows::NCOM::CPropVariant values[5] = {
    (UInt32)5, L"LZMA2:d=32m:mt=1", true, false, false
  };
  HRESULT hr = S_OK;
  for (unsigned i = 0; i < 5; ++i) {
    hr = handlerSpec->SetProperty(names[i], values[i]);
    if (hr != S_OK) {
      snprintf(g_error, sizeof(g_error), "SetProperty failed: 0x%08x", (unsigned)hr);
      return -1;
    }
  }

  CMyComPtr<ISequentialOutStream> out = new CJsOutStream(outputId);
  CMyComPtr<IArchiveUpdateCallback> callback = new CUpdateCallback(sourceId, name, size);
  hr = archive->UpdateItems(out, 1, callback);
  if (hr != S_OK) {
    snprintf(g_error, sizeof(g_error), "UpdateItems failed: 0x%08x", (unsigned)hr);
    return -1;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE
int stream7z_extract(int sourceId, double archiveSizeDouble, int outputId) {
  g_error[0] = 0;
  if (archiveSizeDouble < 0 || archiveSizeDouble > 9007199254740991.0) {
    snprintf(g_error, sizeof(g_error), "invalid archive size");
    return -1;
  }
  const UInt64 archiveSize = (UInt64)archiveSizeDouble;
  if ((double)archiveSize != archiveSizeDouble) {
    snprintf(g_error, sizeof(g_error), "archive size must be an integer");
    return -1;
  }
  NArchive::N7z::CHandler *handlerSpec = new NArchive::N7z::CHandler;
  CMyComPtr<IInArchive> archive = handlerSpec;
  CMyComPtr<IInStream> in = new CJsSeekInStream(sourceId, archiveSize);
  HRESULT hr = archive->Open(in, NULL, NULL);
  if (hr != S_OK) {
    snprintf(g_error, sizeof(g_error), "Open failed: 0x%08x", (unsigned)hr);
    return -1;
  }
  UInt32 numItems = 0;
  hr = archive->GetNumberOfItems(&numItems);
  if (hr != S_OK || numItems != 1) {
    snprintf(g_error, sizeof(g_error), "expected one archive member");
    archive->Close();
    return -1;
  }
  CMyComPtr<IArchiveExtractCallback> callback = new CExtractCallback(outputId);
  const UInt32 index = 0;
  hr = archive->Extract(&index, 1, false, callback);
  archive->Close();
  if (hr != S_OK) {
    snprintf(g_error, sizeof(g_error), "Extract failed: 0x%08x", (unsigned)hr);
    return -1;
  }
  return 0;
}
}
