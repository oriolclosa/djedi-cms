import simplejson as json
from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_exempt
from django.views.generic import View

import cio
import cio.conf

from ..admin.mixins import JSONResponseMixin
from ..auth import has_permission
from ..utils.templates import render_embed


class APIView(JSONResponseMixin, View):
    @csrf_exempt
    def dispatch(self, request, *args, **kwargs):
        return super().dispatch(request, *args, **kwargs)


class EmbedApi(View):
    def get(self, request):
        if has_permission(request):
            return render_embed(request=request)
        else:
            # We used to `raise PermissionDenied` here (which might seem more
            # appropriate), but that has the annoying side effect of being
            # logged as an error in the browser dev tools, making people think
            # something is wrong.
            return HttpResponse(status=204)


class NodesApi(APIView):
    """
    JSON Response:
        {uri: content, uri: content, ...}
    """

    @method_decorator(never_cache)
    def post(self, request):
        # Disable caching gets in CachePipe, defaults through this api is not trusted
        cio.conf.settings.configure(local=True, CACHE={"PIPE": {"CACHE_ON_GET": False}})

        nodes = []
        for uri, default in json.loads(request.body).items():
            node = cio.get(uri, default=default)
            nodes.append(node)

        data = {node.uri: node.content for node in nodes}

        return self.render_to_json(data)

    def get(self, request):
        nodes = []
        for uri, default in json.loads(request.body).items():
            node = cio.get(uri, default=default)
            nodes.append(node)

        data = {node.uri: node.content for node in nodes}

        return self.render_to_json(data)
