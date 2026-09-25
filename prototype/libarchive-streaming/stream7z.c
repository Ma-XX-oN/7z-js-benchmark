#include <archive.h>
#include <archive_entry.h>
#include <emscripten.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define STREAM7Z_IO_BUFFER (64u * 1024u)

typedef struct {
  struct archive *archive;
  unsigned char *input_buffer;
  int source_id;
  double entry_size;
  double raw_bytes_read;
} Stream7zReader;

typedef struct {
  struct archive *archive;
  int output_id;
  double expected_bytes;
  double raw_bytes_written;
  double archive_bytes_written;
} Stream7zWriter;

static char stream7z_error[512];

EM_JS(int, stream7z_js_read, (int source_id, unsigned char *dest, int capacity), {
  const fn = Module['stream7zRead'];
  if (typeof fn !== 'function') return -1;
  return fn(source_id, dest, capacity) | 0;
});

EM_JS(double, stream7z_js_seek, (int source_id, double offset, int whence), {
  const fn = Module['stream7zSeek'];
  if (typeof fn !== 'function') return -1;
  return Number(fn(source_id, offset, whence));
});

EM_JS(int, stream7z_js_write, (int output_id, const unsigned char *data, int length), {
  const fn = Module['stream7zWrite'];
  if (typeof fn !== 'function') return -1;
  return fn(output_id, data, length) | 0;
});

static void stream7z_set_error(const char *message) {
  snprintf(stream7z_error, sizeof(stream7z_error), "%s", message ? message : "unknown error");
}

static void stream7z_set_archive_error(const char *prefix, struct archive *archive) {
  const char *detail = archive ? archive_error_string(archive) : NULL;
  snprintf(stream7z_error, sizeof(stream7z_error), "%s: %s",
      prefix ? prefix : "archive error", detail ? detail : "unknown error");
}

EMSCRIPTEN_KEEPALIVE
const char *stream7z_last_error(void) {
  return stream7z_error;
}

static la_ssize_t stream7z_read_callback(
    struct archive *archive,
    void *client_data,
    const void **buffer) {
  Stream7zReader *reader = (Stream7zReader *)client_data;
  int count = stream7z_js_read(
      reader->source_id,
      reader->input_buffer,
      (int)STREAM7Z_IO_BUFFER);
  if (count < 0) {
    archive_set_error(archive, EIO, "JavaScript source read failed");
    return -1;
  }
  *buffer = reader->input_buffer;
  return (la_ssize_t)count;
}

static la_int64_t stream7z_seek_callback(
    struct archive *archive,
    void *client_data,
    la_int64_t offset,
    int whence) {
  Stream7zReader *reader = (Stream7zReader *)client_data;
  double position = stream7z_js_seek(reader->source_id, (double)offset, whence);
  if (position < 0) {
    archive_set_error(archive, EIO, "JavaScript source seek failed");
    return -1;
  }
  return (la_int64_t)position;
}

static la_int64_t stream7z_skip_callback(
    struct archive *archive,
    void *client_data,
    la_int64_t request) {
  Stream7zReader *reader = (Stream7zReader *)client_data;
  double before = stream7z_js_seek(reader->source_id, 0, SEEK_CUR);
  if (before < 0) {
    archive_set_error(archive, EIO, "JavaScript source position failed");
    return -1;
  }
  double after = stream7z_js_seek(reader->source_id, (double)request, SEEK_CUR);
  if (after < 0) {
    archive_set_error(archive, EIO, "JavaScript source skip failed");
    return -1;
  }
  return (la_int64_t)(after - before);
}

EMSCRIPTEN_KEEPALIVE
Stream7zReader *stream7z_reader_open(int source_id) {
  stream7z_error[0] = '\0';
  Stream7zReader *reader = (Stream7zReader *)calloc(1, sizeof(*reader));
  if (!reader) {
    stream7z_set_error("reader allocation failed");
    return NULL;
  }

  reader->source_id = source_id;
  reader->input_buffer = (unsigned char *)malloc(STREAM7Z_IO_BUFFER);
  if (!reader->input_buffer) {
    stream7z_set_error("reader input buffer allocation failed");
    free(reader);
    return NULL;
  }

  reader->archive = archive_read_new();
  if (!reader->archive) {
    stream7z_set_error("archive_read_new failed");
    free(reader->input_buffer);
    free(reader);
    return NULL;
  }

  if (archive_read_support_filter_none(reader->archive) != ARCHIVE_OK ||
      archive_read_support_format_7zip(reader->archive) != ARCHIVE_OK) {
    stream7z_set_archive_error("7z reader support initialization failed", reader->archive);
    archive_read_free(reader->archive);
    free(reader->input_buffer);
    free(reader);
    return NULL;
  }

  archive_read_set_callback_data(reader->archive, reader);
  archive_read_set_read_callback(reader->archive, stream7z_read_callback);
  archive_read_set_seek_callback(reader->archive, stream7z_seek_callback);
  archive_read_set_skip_callback(reader->archive, stream7z_skip_callback);

  if (archive_read_open1(reader->archive) != ARCHIVE_OK) {
    stream7z_set_archive_error("7z reader open failed", reader->archive);
    archive_read_free(reader->archive);
    free(reader->input_buffer);
    free(reader);
    return NULL;
  }

  struct archive_entry *entry = NULL;
  if (archive_read_next_header(reader->archive, &entry) != ARCHIVE_OK || !entry) {
    stream7z_set_archive_error("7z archive has no readable member", reader->archive);
    archive_read_free(reader->archive);
    free(reader->input_buffer);
    free(reader);
    return NULL;
  }

  la_int64_t size = archive_entry_size(entry);
  if (size < 0) {
    stream7z_set_error("7z member does not expose an uncompressed size");
    archive_read_free(reader->archive);
    free(reader->input_buffer);
    free(reader);
    return NULL;
  }
  reader->entry_size = (double)size;
  return reader;
}

EMSCRIPTEN_KEEPALIVE
double stream7z_reader_size(Stream7zReader *reader) {
  return reader ? reader->entry_size : -1;
}

EMSCRIPTEN_KEEPALIVE
int stream7z_reader_read(Stream7zReader *reader, unsigned char *dest, int capacity) {
  if (!reader || !dest || capacity <= 0) {
    stream7z_set_error("invalid reader_read arguments");
    return -1;
  }
  la_ssize_t count = archive_read_data(reader->archive, dest, (size_t)capacity);
  if (count < 0) {
    stream7z_set_archive_error("7z member decompression failed", reader->archive);
    return -1;
  }
  reader->raw_bytes_read += (double)count;
  return (int)count;
}

EMSCRIPTEN_KEEPALIVE
double stream7z_reader_bytes_read(Stream7zReader *reader) {
  return reader ? reader->raw_bytes_read : -1;
}

EMSCRIPTEN_KEEPALIVE
int stream7z_reader_close(Stream7zReader *reader) {
  if (!reader) return 0;
  int result = archive_read_free(reader->archive);
  if (result != ARCHIVE_OK) {
    stream7z_set_error("archive_read_free failed");
  }
  free(reader->input_buffer);
  free(reader);
  return result == ARCHIVE_OK ? 0 : -1;
}

static la_ssize_t stream7z_write_callback(
    struct archive *archive,
    void *client_data,
    const void *buffer,
    size_t length) {
  Stream7zWriter *writer = (Stream7zWriter *)client_data;
  if (length > INT32_MAX) {
    archive_set_error(archive, EOVERFLOW, "output block exceeds JavaScript callback limit");
    return -1;
  }
  int written = stream7z_js_write(writer->output_id, buffer, (int)length);
  if (written < 0 || (size_t)written != length) {
    archive_set_error(archive, EIO, "JavaScript output write failed");
    return -1;
  }
  writer->archive_bytes_written += (double)written;
  return (la_ssize_t)written;
}

EMSCRIPTEN_KEEPALIVE
Stream7zWriter *stream7z_writer_begin(
    int output_id,
    const char *member_name,
    double expected_bytes) {
  stream7z_error[0] = '\0';
  if (!member_name || expected_bytes < 0 || expected_bytes > 9007199254740991.0) {
    stream7z_set_error("invalid writer_begin arguments");
    return NULL;
  }

  Stream7zWriter *writer = (Stream7zWriter *)calloc(1, sizeof(*writer));
  if (!writer) {
    stream7z_set_error("writer allocation failed");
    return NULL;
  }
  writer->output_id = output_id;
  writer->expected_bytes = expected_bytes;
  writer->archive = archive_write_new();
  if (!writer->archive) {
    stream7z_set_error("archive_write_new failed");
    free(writer);
    return NULL;
  }

  if (archive_write_set_format_7zip(writer->archive) != ARCHIVE_OK ||
      archive_write_add_filter_none(writer->archive) != ARCHIVE_OK ||
      archive_write_set_format_option(
          writer->archive, "7zip", "compression", "lzma2") != ARCHIVE_OK ||
      archive_write_set_format_option(
          writer->archive, "7zip", "compression-level", "5") != ARCHIVE_OK) {
    stream7z_set_archive_error("7z writer configuration failed", writer->archive);
    archive_write_free(writer->archive);
    free(writer);
    return NULL;
  }

  archive_write_set_bytes_per_block(writer->archive, 64 * 1024);
  archive_write_set_bytes_in_last_block(writer->archive, 1);
  if (archive_write_open(
      writer->archive,
      writer,
      NULL,
      stream7z_write_callback,
      NULL) != ARCHIVE_OK) {
    stream7z_set_archive_error("7z output open failed", writer->archive);
    archive_write_free(writer->archive);
    free(writer);
    return NULL;
  }

  struct archive_entry *entry = archive_entry_new();
  if (!entry) {
    stream7z_set_error("archive entry allocation failed");
    archive_write_free(writer->archive);
    free(writer);
    return NULL;
  }
  archive_entry_set_pathname(entry, member_name);
  archive_entry_set_size(entry, (la_int64_t)expected_bytes);
  archive_entry_set_filetype(entry, AE_IFREG);
  archive_entry_set_perm(entry, 0644);

  int header_result = archive_write_header(writer->archive, entry);
  archive_entry_free(entry);
  if (header_result != ARCHIVE_OK) {
    stream7z_set_archive_error("7z member header write failed", writer->archive);
    archive_write_free(writer->archive);
    free(writer);
    return NULL;
  }
  return writer;
}

EMSCRIPTEN_KEEPALIVE
int stream7z_writer_write(Stream7zWriter *writer, const unsigned char *data, int length) {
  if (!writer || (!data && length != 0) || length < 0) {
    stream7z_set_error("invalid writer_write arguments");
    return -1;
  }
  int offset = 0;
  while (offset < length) {
    la_ssize_t count = archive_write_data(
        writer->archive,
        data + offset,
        (size_t)(length - offset));
    if (count <= 0) {
      stream7z_set_archive_error("7z compression write failed", writer->archive);
      return -1;
    }
    offset += (int)count;
    writer->raw_bytes_written += (double)count;
  }
  return offset;
}

EMSCRIPTEN_KEEPALIVE
double stream7z_writer_bytes_written(Stream7zWriter *writer) {
  return writer ? writer->raw_bytes_written : -1;
}

EMSCRIPTEN_KEEPALIVE
double stream7z_writer_archive_bytes(Stream7zWriter *writer) {
  return writer ? writer->archive_bytes_written : -1;
}

EMSCRIPTEN_KEEPALIVE
int stream7z_writer_finish(Stream7zWriter *writer) {
  if (!writer) {
    stream7z_set_error("invalid writer_finish argument");
    return -1;
  }
  int result = 0;
  if (writer->raw_bytes_written != writer->expected_bytes) {
    snprintf(stream7z_error, sizeof(stream7z_error),
        "raw byte count mismatch: wrote %.0f expected %.0f",
        writer->raw_bytes_written,
        writer->expected_bytes);
    result = -1;
  } else if (archive_write_finish_entry(writer->archive) != ARCHIVE_OK) {
    stream7z_set_archive_error("7z finish entry failed", writer->archive);
    result = -1;
  } else if (archive_write_close(writer->archive) != ARCHIVE_OK) {
    stream7z_set_archive_error("7z close failed", writer->archive);
    result = -1;
  }

  if (archive_write_free(writer->archive) != ARCHIVE_OK && result == 0) {
    stream7z_set_error("archive_write_free failed");
    result = -1;
  }
  free(writer);
  return result;
}
